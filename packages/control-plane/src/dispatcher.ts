/**
 * Dispatcher (SPEC S4): the control-plane loop that turns pending tasks into
 * running workers. It polls the task inbox, marks a task running, and spawns a
 * worker process for the assigned unit with the ORG_* environment wired so the
 * worker's extensions connect back to the control plane and report their
 * result via org_complete / org_escalate (ADR-0003).
 *
 * The worker spawner is injected so the loop is testable without launching a
 * real `pi --mode json`; the default spawner does launch one.
 */

import { type ChildProcess, spawn } from "node:child_process";

import type { ControlStore, TaskRow, UnitRow } from "./store-control.ts";
import { ENV_DB, ENV_SOCKET, ENV_TASK, ENV_TOKEN, ENV_UNIT } from "./unit-config.ts";

/** Everything a worker needs to act as its unit against the control plane. */
export interface WorkerSpec {
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
	/** Injected worker launcher (default spawns `pi --mode json`). */
	spawner?: WorkerSpawner;
}

export class Dispatcher {
	private readonly store: ControlStore;
	private readonly socketPath: string;
	private readonly workspaceOf: (unit: UnitRow) => string;
	private readonly tokenOf: (unitId: string) => string | undefined;
	private readonly spawner: WorkerSpawner;

	constructor(opts: DispatcherOptions) {
		this.store = opts.store;
		this.socketPath = opts.socketPath;
		this.workspaceOf = opts.workspaceOf ?? ((u) => `/srv/org/${u.path}`);
		this.tokenOf = opts.tokenOf ?? (() => undefined);
		this.spawner = opts.spawner ?? defaultSpawner;
	}

	/**
	 * Process all currently-pending tasks once: for each, mark it running and
	 * spawn its worker. Returns the task ids dispatched. A unit that is not
	 * active, or whose unit row is missing, is skipped (left pending).
	 */
	async tick(): Promise<string[]> {
		const dispatched: string[] = [];
		for (const task of this.store.listTasksByStatus("pending")) {
			const unit = this.store.getUnit(task.toUnit);
			if (!unit || unit.status !== "active") continue;
			// Mark running before spawning so a crash leaves a running task the
			// scheduler can later reconcile, never a lost pending task.
			this.store.startTask(task.id);
			const spec = this.buildSpec(task, unit);
			try {
				await this.spawner(spec);
				dispatched.push(task.id);
			} catch (e) {
				// Spawn failed: record it and let the task be retried/escalated.
				this.store.append("task", "control", "dispatch.error", task.id, { reason: (e as Error).message });
			}
		}
		return dispatched;
	}

	private buildSpec(task: TaskRow, unit: UnitRow): WorkerSpec {
		const token = this.tokenOf(unit.id);
		const env: Record<string, string> = {
			[ENV_UNIT]: unit.id,
			[ENV_DB]: this.store.dbPath,
			[ENV_TASK]: task.id,
			[ENV_SOCKET]: this.socketPath,
		};
		if (token) env[ENV_TOKEN] = token;
		return { task, unit, env, cwd: this.workspaceOf(unit) };
	}
}

/** Default spawner: launch `pi --mode json` as the worker for this unit. */
export const defaultSpawner: WorkerSpawner = (spec) => {
	const child: ChildProcess = spawn("pi", ["--mode", "json"], {
		cwd: spec.cwd,
		env: { ...process.env, ...spec.env },
		stdio: ["ignore", "pipe", "pipe"],
		detached: false,
	});
	// The worker reports its artifact back through the control plane; the
	// dispatcher does not block on its exit here. Unref so the control process
	// is not kept alive solely by the child.
	child.unref();
};
