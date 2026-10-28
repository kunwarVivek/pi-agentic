/**
 * Dispatcher (SPEC S4): the control-plane loop that turns pending tasks into
 * running workers. It polls the task inbox, marks a task running, and spawns a
 * worker process for the assigned unit with the ORG_* environment wired so the
 * worker's extensions connect back to the control plane and report their
 * result via org_complete / org_escalate (ADR-0003).
 *
 * The worker spawner is REQUIRED and injected (see spawners.ts): production
 * runs the worker as the unit's OS user with an allowlisted env; a dev spawner
 * exists but is explicit opt-in. There is no implicit default.
 */

import { dirname, join } from "node:path";

import type { ControlStore, TaskRow, UnitRow } from "./store-control.ts";
import { ENV_DB, ENV_SOCKET, ENV_TASK, ENV_TOKEN, ENV_UNIT } from "./unit-config.ts";

/**
 * How a worker is launched. `pi` runs `pi --mode json` with the org extension;
 * `durable` runs the `agentic-pi-durable-worker` bin (pi-durable Harness per
 * task, ADR-0009).
 */
export type WorkerMode = "pi" | "durable";

/** Executable the `durable` mode launches (from pi-agentic-durable). */
export const DURABLE_WORKER_BIN = "agentic-pi-durable-worker";
/** Directory holding the task's pi-durable storage + lock (durable mode only). */
export const ENV_DURABLE_DIR = "ORG_DURABLE_DIR";
/** Default root of per-unit root-owned manifests: `<dir>/<id>/unit.json` (deploy renders them there). */
export const DEFAULT_MANIFEST_DIR = "/etc/agentic-pi/units";

/** Everything a worker needs to act as its unit against the control plane. */
export interface WorkerSpec {
	mode: WorkerMode;
	task: TaskRow;
	unit: UnitRow;
	env: Record<string, string>;
	/** Filesystem cwd the worker should run in (unit's workspace). */
	cwd: string;
}

/** Launch a worker for a task. Returns when the worker has been started. */
export type WorkerSpawner = (spec: WorkerSpec) => Promise<void> | void;

export interface DispatcherOptions {
	store: ControlStore;
	socketPath: string;
	/** Resolve a unit's filesystem workspace. Default: /srv/org/<path>. */
	workspaceOf?: (unit: UnitRow) => string;
	/** Resolve the dev token for a unit (uid auth needs none). */
	tokenOf?: (unitId: string) => string | undefined;
	/** Worker launcher (spawners.ts: systemd / uid / dev). Required: no implicit default. */
	spawner: WorkerSpawner;
	/**
	 * Per-unit control socket path (ADR-0003). When set, workers get it as
	 * ORG_CONTROL_SOCKET and authenticate by socket identity: no dev token and
	 * no ORG_CONTROL_DB are handed out.
	 */
	unitSocketOf?: (unit: UnitRow) => string;
	/** Absolute path of the unit's unit.json (ORG_UNIT_MANIFEST). Overrides `manifestDirOf`. */
	manifestOf?: (unit: UnitRow) => string;
	/**
	 * Directory of the unit's ROOT-owned manifest (and `secrets.env`): `<dir>/unit.json`.
	 * Default `<DEFAULT_MANIFEST_DIR>/<id>` (units must not be able to edit their own manifest).
	 */
	manifestDirOf?: (unitId: string) => string;
	/** The unit's private Pi agent dir (PI_CODING_AGENT_DIR). Unset: not exported. */
	agentDirOf?: (unit: UnitRow) => string;
	/** Optional bwrap binary exported as ORG_BWRAP_BIN to bash units. */
	bwrapBin?: string;
	/** Runs before each unit's worker is spawned (e.g. ensure its socket exists). Failure skips the unit. */
	prepareUnit?: (unit: UnitRow) => Promise<void> | void;
	/** True when the unit already has a live worker; its pending tasks stay pending. */
	isUnitBusy?: (unit: UnitRow) => Promise<boolean> | boolean;
	/** Worker launch mode. Default `pi`. */
	workerMode?: WorkerMode;
	/** Durable mode: a unit's pi-durable state dir. Default: `<dir of control.db>/durable/<unit id>`. */
	durableDirOf?: (unit: UnitRow) => string;
}

export class Dispatcher {
	private readonly store: ControlStore;
	private readonly socketPath: string;
	private readonly workspaceOf: (unit: UnitRow) => string;
	private readonly tokenOf: (unitId: string) => string | undefined;
	private readonly spawner: WorkerSpawner;
	private readonly opts: DispatcherOptions;
	private readonly workerMode: WorkerMode;
	private readonly durableDirOf: (unit: UnitRow) => string;
	private readonly manifestDirOf: (unitId: string) => string;

	constructor(opts: DispatcherOptions) {
		this.opts = opts;
		this.store = opts.store;
		this.socketPath = opts.socketPath;
		this.workspaceOf = opts.workspaceOf ?? ((u) => `/srv/org/${u.path}`);
		this.tokenOf = opts.tokenOf ?? (() => undefined);
		this.spawner = opts.spawner;
		this.workerMode = opts.workerMode ?? "pi";
		this.durableDirOf = opts.durableDirOf ?? ((u) => join(dirname(this.store.dbPath), "durable", u.id));
		this.manifestDirOf = opts.manifestDirOf ?? ((id) => join(DEFAULT_MANIFEST_DIR, id));
	}

	/**
	 * Process all currently-pending tasks once: for each, mark it running and
	 * spawn its worker. Returns the task ids dispatched. A unit that is not
	 * active, or whose unit row is missing, is skipped (left pending).
	 */
	async tick(): Promise<string[]> {
		const dispatched: string[] = [];
		for (const task of this.store.listTasksByStatus("pending")) {
			// One task's failure (systemctl hiccup, task changed under us, spawn error) never aborts the sweep or the process.
			try {
				if (await this.dispatchOne(task.id)) dispatched.push(task.id);
			} catch (e) {
				try {
					this.store.append("task", "control", "dispatch.error", task.id, { reason: (e as Error).message });
				} catch {
					// audit failure must not escape either
				}
			}
		}
		return dispatched;
	}

	private async dispatchOne(taskId: string): Promise<boolean> {
		const unitId = this.store.getTask(taskId)?.toUnit;
		const unit = unitId ? this.store.getUnit(unitId) : null;
		if (!unit || unit.status !== "active") return false;
		if (await this.opts.isUnitBusy?.(unit)) return false;
		try {
			await this.opts.prepareUnit?.(unit);
		} catch (e) {
			this.store.append("task", "control", "dispatch.error", taskId, { reason: `prepare unit failed: ${(e as Error).message}` });
			return false;
		}
		// The awaits above can race a cancel/complete: start only a task that is still pending.
		const task = this.store.getTask(taskId);
		if (!task || task.status !== "pending") return false;
		const spec = this.buildSpec(task, unit);
		// Mark running before spawning so a crash leaves a running task the
		// scheduler can later reconcile, never a lost pending task.
		this.store.startTask(task.id);
		try {
			await this.spawner(spec);
			return true;
		} catch (e) {
			// Spawn failed: the task must not stay `running` with nobody to run it. Escalate it
			// (retry/cancel) so its reservation is released or the owner re-queues it.
			const reason = (e as Error).message;
			this.store.append("task", "control", "dispatch.error", task.id, { reason });
			this.store.escalate(task.id, `worker spawn failed: ${reason}`, ["retry", "cancel"]);
			return false;
		}
	}

	private buildSpec(task: TaskRow, unit: UnitRow): WorkerSpec {
		const cwd = this.workspaceOf(unit);
		const env: Record<string, string> = {
			[ENV_UNIT]: unit.id,
			[ENV_TASK]: task.id,
			ORG_UNIT_MANIFEST: this.opts.manifestOf?.(unit) ?? join(this.manifestDirOf(unit.id), "unit.json"),
		};
		if (this.opts.unitSocketOf) {
			// Identity = the unit's own socket; no db path, no bearer token.
			env[ENV_SOCKET] = this.opts.unitSocketOf(unit);
		} else {
			env[ENV_SOCKET] = this.socketPath;
			env[ENV_DB] = this.store.dbPath;
			const token = this.tokenOf(unit.id);
			if (token) env[ENV_TOKEN] = token;
		}
		const agentDir = this.opts.agentDirOf?.(unit);
		if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
		if (unit.grants.some((g) => g.kind === "tool" && g.name === "bash")) {
			env.ORG_BWRAP = "1";
			if (this.opts.bwrapBin) env.ORG_BWRAP_BIN = this.opts.bwrapBin;
		}
		if (this.workerMode === "durable") env[ENV_DURABLE_DIR] = this.durableDirOf(unit);
		return { mode: this.workerMode, task, unit, env, cwd };
	}
}
