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
 *
 * The wiring is exposed as `startControlPlane` so an integration test can drive
 * it against a temp db and a fake clock; the `main()` guard runs it for real.
 */

import { ControlStore } from "./store-control.ts";
import { PeerRegistry } from "./auth.ts";
import { Dispatcher, type WorkerSpawner } from "./dispatcher.ts";
import { Scheduler } from "./scheduler.ts";
import { ControlServer } from "./server.ts";
import { writeFileSync } from "node:fs";

export interface ControlPlaneOptions {
	dbPath: string;
	socketPath: string;
	intervalMs?: number;
	/** Start the automatic scheduler loop (default true). Tests pass false and
	 * drive `scheduler.sweep()` by hand. */
	autoStart?: boolean;
	/** Injected worker launcher. Default (production) spawns `pi --mode json`;
	 * tests pass a fake so no real worker process is launched. */
	spawner?: WorkerSpawner;
	/** Injected clock for the store (default Date.now). Tests pass a fake. */
	clock?: () => number;
	/** When set, issue an operator admin token and write it mode-600 here (ADR-0007). */
	adminTokenFile?: string;
}

export interface ControlPlane {
	store: ControlStore;
	registry: PeerRegistry;
	server: ControlServer;
	dispatcher: Dispatcher;
	scheduler: Scheduler;
	/** The operator admin token (human root), when one was issued. */
	adminToken: string | null;
	/** Stop the scheduler and close the socket. Does not delete control.db. */
	stop(): Promise<void>;
}

/** Wire and start the control plane. Returns a handle for shutdown + testing. */
export async function startControlPlane(opts: ControlPlaneOptions): Promise<ControlPlane> {
	const store = new ControlStore(opts.dbPath, opts.clock ? { clock: opts.clock } : {});
	const registry = new PeerRegistry();
	const server = new ControlServer({ store, auth: registry });
	const dispatcher = new Dispatcher({
		store,
		socketPath: opts.socketPath,
		// A worker authenticates with the dev token the registry issued for it.
		tokenOf: (unitId) => registry.issueToken(unitId),
		...(opts.spawner ? { spawner: opts.spawner } : {}),
	});
	const scheduler = new Scheduler({
		store,
		dispatcher,
		...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
	});

	await server.listen(opts.socketPath);
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
		async stop() {
			scheduler.stop();
			await server.close();
			store.close();
		},
	};
}

/** Read required configuration from the environment or fail closed. */
function configFromEnv(): ControlPlaneOptions {
	const dbPath = process.env.ORG_CONTROL_DB;
	const socketPath = process.env.ORG_CONTROL_SOCKET;
	if (!dbPath) throw new Error("ORG_CONTROL_DB is required");
	if (!socketPath) throw new Error("ORG_CONTROL_SOCKET is required");
	const raw = process.env.ORG_SWEEP_INTERVAL_MS;
	const intervalMs = raw ? Number(raw) : undefined;
	if (intervalMs !== undefined && (!Number.isFinite(intervalMs) || intervalMs <= 0)) {
		throw new Error("ORG_SWEEP_INTERVAL_MS must be a positive number");
	}
	const adminTokenFile = process.env.ORG_ADMIN_TOKEN_FILE;
	return {
		dbPath,
		socketPath,
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
}

// Run only when executed directly, not when imported by a test.
if (import.meta.main) {
	main().catch((e: unknown) => {
		console.error(`pi-control failed to start: ${(e as Error).message}`);
		process.exit(1);
	});
}