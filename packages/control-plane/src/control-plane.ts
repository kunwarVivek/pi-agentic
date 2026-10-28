#!/usr/bin/env node
/**
 * `pi-control` \u2014 the control-plane entrypoint (SPEC S5). One process, run as the
 * `pi-control` user, that owns control.db and wires together the three pieces
 * built in S4/S5:
 *   - ControlServer: the Unix-socket RPC endpoint workers call (ADR-0003).
 *   - Dispatcher:    turns pending tasks into worker processes.
 *   - Scheduler:     periodic lifecycle + approval-expiry + dispatch sweeps.
 *
 * Configuration is environment-only so it drops into a systemd unit cleanly:
 *   ORG_CONTROL_DB       path to control.db          (required)
 *   ORG_CONTROL_SOCKET   Unix socket to listen on    (required)
 *   ORG_SWEEP_INTERVAL_MS  scheduler interval in ms  (optional, default 60000)
 *   ORG_ADMIN_TOKEN_FILE   where to write the operator admin token (optional)
 *   ORG_UNIT_SOCKET_DIR  dir of per-unit sockets <id>.sock (required unless ORG_SPAWNER=dev)
 *   ORG_SPAWNER          systemd (default) | uid (root only) | dev (needs AGENTIC_PI_DEV=1)
 *   ORG_WORKER_MODE      pi (default) | durable: which worker the dispatcher launches (anything else fails closed)
 *   ORG_JUDGE            none (default, the only accepted value): no judge implementation ships, so a
 *                        contract with `judge: true` is refused at delegate (fail closed)
 *   ORG_MANIFEST_DIR     root-owned manifests <dir>/<id>/unit.json (optional; default /etc/agentic-pi/units, dev: workspace)
 *   ORG_UNIT_ENV_DIR, ORG_WORKSPACE_ROOT, ORG_UNITS_DIR, ORG_BWRAP_BIN, ORG_PI_CLI, ORG_NODE_BIN  (optional)
 *
 * The wiring is exposed as `startControlPlane` so an integration test can drive
 * it against a temp db and a fake clock; the `main()` guard runs it for real.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ControlStore, type UnitRow } from "./store-control.ts";
import { PeerRegistry } from "./auth.ts";
import { Dispatcher, type WorkerMode, type WorkerSpawner } from "./dispatcher.ts";
import { Scheduler } from "./scheduler.ts";
import { ControlServer } from "./server.ts";
import { WorkerTracker, createDevSpawner, createSystemdSpawner, createUidSpawner, unitGroupGid } from "./spawners.ts";

/** A unit id must be a safe path component before it becomes a socket / dir name. */
const SAFE_UNIT_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Which production spawner launches workers (default `systemd`). `dev` is explicit opt-in. */
export type SpawnerKind = "systemd" | "uid" | "dev";

export interface UnitSocketOptions {
	/** Directory holding one socket per unit (`<dir>/<id>.sock`). Created 0711. */
	dir: string;
	/**
	 * gid the socket is chgrp'd to for a unit (its `pi-u-<id>` group). Default: look
	 * `pi-u-<id>` up in /etc/group and FAIL CLOSED when it does not exist.
	 */
	gidOf?: (unitId: string) => number | undefined;
	/** Socket mode (default 0660: owner control plane + the unit's group only). */
	mode?: number;
}

export interface ControlPlaneOptions {
	dbPath: string;
	socketPath: string;
	intervalMs?: number;
	/** Start the automatic scheduler loop (default true). Tests pass false and
	 * drive `scheduler.sweep()` by hand. */
	autoStart?: boolean;
	/** Injected worker launcher (tests). Takes precedence over `spawnerKind`. */
	spawner?: WorkerSpawner;
	/** Production spawner selection when no `spawner` is injected (default `systemd`). */
	spawnerKind?: SpawnerKind;
	/** Per-unit sockets (ADR-0003). REQUIRED for any non-dev production spawner. */
	unitSockets?: UnitSocketOptions;
	/** Dir for per-task EnvironmentFiles of the systemd spawner (default `<unitSockets.dir>/env`, 0700). */
	unitEnvDir?: string;
	/** Worker cwd root (default /srv/org). */
	workspaceRoot?: string;
	/** Per-unit state root: `<unitsRoot>/<id>/agent-dir` is the unit's PI_CODING_AGENT_DIR. */
	unitsRoot?: string;
	/** bwrap binary exported to bash units as ORG_BWRAP_BIN. */
	bwrapBin?: string;
	/** Worker launch mode (default `pi`). */
	workerMode?: WorkerMode;
	/** Used by the uid spawner: `<nodeBin> <piCli>` instead of the `pi` launcher. */
	piCli?: string;
	nodeBin?: string;
	/** Injected clock for the store (default Date.now). Tests pass a fake. */
	clock?: () => number;
	/** When set, issue an operator admin token and write it mode-600 here (ADR-0007). */
	adminTokenFile?: string;
	/** Root of per-unit root-owned manifests `<dir>/<id>/unit.json` (+ `secrets.env`). Default /etc/agentic-pi/units (dev spawner: workspace). */
	manifestDir?: string;
}

/** A unit whose per-unit socket could not be created. */
export interface SocketSyncFailure {
	unitId: string;
	reason: string;
}

export interface ControlPlane {
	store: ControlStore;
	registry: PeerRegistry;
	server: ControlServer;
	dispatcher: Dispatcher;
	scheduler: Scheduler;
	/** The operator admin token (human root), when one was issued. */
	adminToken: string | null;
	/** Socket path of a unit's per-unit socket (undefined when per-unit sockets are off). */
	unitSocketOf(unitId: string): string | undefined;
	/** Start listening on a per-unit socket for every unit in the store not yet served. A unit that fails is skipped and reported, never fatal. */
	syncUnitSockets(): Promise<SocketSyncFailure[]>;
	/** Units whose socket could not be created at the last sync (audited as unit.socket_error). */
	socketFailures: readonly SocketSyncFailure[];
	/** Stop the scheduler and close the socket. Does not delete control.db. */
	stop(): Promise<void>;
}

/** Wire and start the control plane. Returns a handle for shutdown + testing. */
export async function startControlPlane(opts: ControlPlaneOptions): Promise<ControlPlane> {
	const kind: SpawnerKind = opts.spawnerKind ?? "systemd";
	if (!opts.spawner && kind !== "dev" && !opts.unitSockets) {
		throw new Error(`spawner "${kind}" needs per-unit sockets (ORG_UNIT_SOCKET_DIR): workers authenticate by socket identity`);
	}
	const store = new ControlStore(opts.dbPath, opts.clock ? { clock: opts.clock } : {});
	const registry = new PeerRegistry();
	const server = new ControlServer({ store, auth: registry, afterUnitsAdded: () => syncUnitSockets() });
	const us = opts.unitSockets;
	const socketOf = (id: string): string => {
		if (!SAFE_UNIT_ID.test(id)) throw new Error(`unsafe unit id for a socket path: ${JSON.stringify(id)}`);
		return join(us!.dir, `${id}.sock`);
	};
	if (us) {
		mkdirSync(us.dir, { recursive: true, mode: 0o711 });
		// Traverse-only for everyone: a unit can reach its own socket by name, never list the others.
		chmodSync(us.dir, 0o711);
	}
	const gidOf = us?.gidOf ?? ((id: string) => unitGroupGid(id) ?? undefined);
	const ensureSocket = async (unitId: string): Promise<void> => {
		if (!us) return;
		const gid = gidOf(unitId);
		if (gid === undefined) throw new Error(`no group for unit ${unitId}: create user/group pi-u-${unitId} first (fail closed)`);
		await server.listenUnit(socketOf(unitId), unitId, { gid, ...(us.mode !== undefined ? { mode: us.mode } : {}) });
	};
	const socketFailures: SocketSyncFailure[] = [];
	const syncUnitSockets = async (): Promise<SocketSyncFailure[]> => {
		// One unit's bad id / missing group / over-long socket path must not stop the others (or the plane).
		const failed: SocketSyncFailure[] = [];
		for (const u of store.listUnits()) {
			try {
				await ensureSocket(u.id);
			} catch (e) {
				const reason = (e as Error).message;
				failed.push({ unitId: u.id, reason });
				try {
					store.append("unit", "control", "unit.socket_error", u.id, { reason });
				} catch {
					// audit is best effort here
				}
				console.error(`pi-control: no socket for unit ${u.id}: ${reason}`);
			}
		}
		socketFailures.splice(0, socketFailures.length, ...failed);
		return failed;
	};

	let spawner: WorkerSpawner;
	let isUnitBusy: ((u: UnitRow) => Promise<boolean> | boolean) | undefined;
	// uid/dev workers are plain child processes: track them so a unit with a live worker is busy.
	const tracker = new WorkerTracker();
	if (opts.spawner) spawner = opts.spawner;
	else if (kind === "dev") {
		spawner = createDevSpawner({ tracker });
		isUnitBusy = (u) => tracker.isBusy(u.id);
	} else if (kind === "uid") {
		spawner = createUidSpawner({ tracker, ...(opts.nodeBin ? { nodeBin: opts.nodeBin } : {}), ...(opts.piCli ? { piCli: opts.piCli } : {}) });
		isUnitBusy = (u) => tracker.isBusy(u.id);
	} else {
		const sd = createSystemdSpawner({ envDir: opts.unitEnvDir ?? join(us!.dir, "env") });
		spawner = sd.spawn;
		isUnitBusy = (u) => sd.isBusy(u.id);
	}
	const workspaceRoot = opts.workspaceRoot ?? "/srv/org";
	const dispatcher = new Dispatcher({
		store,
		socketPath: opts.socketPath,
		spawner,
		...(opts.workerMode ? { workerMode: opts.workerMode } : {}),
		workspaceOf: (u) => join(workspaceRoot, u.path),
		...(us
			? { unitSocketOf: (u: UnitRow) => socketOf(u.id), prepareUnit: (u: UnitRow) => ensureSocket(u.id) }
			: // Shared-socket dev mode: a worker authenticates with the dev token the registry issued.
				{ tokenOf: (unitId: string) => registry.issueToken(unitId) }),
		...(opts.unitsRoot ? { agentDirOf: (u: UnitRow) => join(opts.unitsRoot!, u.id, "agent-dir") } : {}),
		...(opts.bwrapBin ? { bwrapBin: opts.bwrapBin } : {}),
		...(isUnitBusy ? { isUnitBusy } : {}),
		...(opts.manifestDir !== undefined ? { manifestDirOf: (id: string) => join(opts.manifestDir!, id) } : {}),
		// Dev keeps the manifest in the workspace (the dev user owns it anyway); production reads the root-owned copy.
		...(opts.manifestDir === undefined && kind === "dev" && !opts.spawner ? { manifestOf: (u: UnitRow) => join(workspaceRoot, u.path, "unit.json") } : {}),
	});
	const scheduler = new Scheduler({
		store,
		dispatcher,
		...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
	});

	await server.listen(opts.socketPath);
	try {
		await syncUnitSockets();
	} catch (e) {
		await server.close();
		store.close();
		throw e;
	}
	if (opts.autoStart !== false) scheduler.start();

	// The operator CLI (human root) authenticates with an admin token, written to
	// a mode-600 file so only the control-plane user (and root) can read it.
	let adminToken: string | null = null;
	if (opts.adminTokenFile) {
		adminToken = registry.issueAdminToken();
		writeFileSync(opts.adminTokenFile, adminToken, { mode: 0o600 });
	}

	return {
		store,
		registry,
		server,
		dispatcher,
		scheduler,
		adminToken,
		unitSocketOf: (unitId) => (us ? socketOf(unitId) : undefined),
		syncUnitSockets,
		socketFailures,
		async stop() {
			scheduler.stop();
			await server.close();
			store.close();
		},
	};
}

/** Read configuration from an env bag (default process.env) or fail closed. */
export function configFromEnv(env: Record<string, string | undefined> = process.env): ControlPlaneOptions {
	const dbPath = env.ORG_CONTROL_DB;
	const socketPath = env.ORG_CONTROL_SOCKET;
	if (!dbPath) throw new Error("ORG_CONTROL_DB is required");
	if (!socketPath) throw new Error("ORG_CONTROL_SOCKET is required");
	const raw = env.ORG_SWEEP_INTERVAL_MS;
	const intervalMs = raw ? Number(raw) : undefined;
	if (intervalMs !== undefined && (!Number.isFinite(intervalMs) || intervalMs <= 0)) {
		throw new Error("ORG_SWEEP_INTERVAL_MS must be a positive number");
	}
	const adminTokenFile = env.ORG_ADMIN_TOKEN_FILE;
	const kind = env.ORG_SPAWNER ?? "systemd";
	if (kind !== "systemd" && kind !== "uid" && kind !== "dev") throw new Error(`ORG_SPAWNER must be systemd|uid|dev, got ${JSON.stringify(kind)}`);
	const socketDir = env.ORG_UNIT_SOCKET_DIR;
	if (kind !== "dev" && !socketDir) throw new Error("ORG_UNIT_SOCKET_DIR is required (per-unit sockets, ADR-0003)");
	const workerMode = env.ORG_WORKER_MODE ?? "pi";
	if (workerMode !== "pi" && workerMode !== "durable") throw new Error(`ORG_WORKER_MODE must be pi|durable, got ${JSON.stringify(workerMode)}`);
	// No LLM judge ships with agentic-pi: contracts with `judge: true` are refused (fail closed).
	// A judge is code (a JudgeFn passed to startControlPlane), never configuration.
	const judgeEnv = env.ORG_JUDGE ?? "none";
	if (judgeEnv !== "none") throw new Error(`ORG_JUDGE must be "none" (no judge implementation ships; contracts with judge:true are refused), got ${JSON.stringify(judgeEnv)}`);
	return {
		dbPath,
		socketPath,
		spawnerKind: kind,
		workerMode,
		...(socketDir ? { unitSockets: { dir: socketDir } } : {}),
		...(env.ORG_UNIT_ENV_DIR ? { unitEnvDir: env.ORG_UNIT_ENV_DIR } : {}),
		...(env.ORG_WORKSPACE_ROOT ? { workspaceRoot: env.ORG_WORKSPACE_ROOT } : {}),
		...(env.ORG_UNITS_DIR ? { unitsRoot: env.ORG_UNITS_DIR } : {}),
		...(env.ORG_BWRAP_BIN ? { bwrapBin: env.ORG_BWRAP_BIN } : {}),
		...(env.ORG_PI_CLI ? { piCli: env.ORG_PI_CLI } : {}),
		...(env.ORG_NODE_BIN ? { nodeBin: env.ORG_NODE_BIN } : {}),
		...(env.ORG_MANIFEST_DIR ? { manifestDir: env.ORG_MANIFEST_DIR } : {}),
		...(intervalMs !== undefined ? { intervalMs } : {}),
		...(adminTokenFile ? { adminTokenFile } : {}),
	};
}

async function main(): Promise<void> {
	const plane = await startControlPlane(configFromEnv());
	const shutdown = (): void => {
		void plane.stop().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	console.error(`pi-control listening on ${process.env.ORG_CONTROL_SOCKET}`);
	console.error(`pi-control worker mode: ${process.env.ORG_WORKER_MODE ?? "pi"}`);
}

// Run only when executed directly, not when imported by a test.
if (import.meta.main) {
	main().catch((e: unknown) => {
		console.error(`pi-control failed to start: ${(e as Error).message}`);
		process.exit(1);
	});
}