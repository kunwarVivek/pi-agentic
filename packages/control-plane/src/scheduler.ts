/**
 * Scheduler (SPEC S5 / FR8): the periodic control-plane maintenance loop. One
 * `sweep()` does three independent jobs, each already implemented on the store:
 *   - lifecycle transitions (expiry \u2192 suspended, idle \u2192 retired, low eval \u2192 deprecated)
 *   - approval TTL expiry (route up one level, or deny at the root)
 *   - dispatch of pending tasks into workers
 *
 * The loop is driven by `start()` (a wall-clock interval) but every job is also
 * callable directly through `sweep()`, so tests inject a fake clock into the
 * store and drive sweeps by hand without any timers.
 */

import type { ControlStore, LifecycleTransition } from "./store-control.ts";
import type { Dispatcher } from "./dispatcher.ts";

export interface SchedulerOptions {
	store: ControlStore;
	dispatcher: Dispatcher;
	/** Interval between automatic sweeps in ms (default 60s). */
	intervalMs?: number;
}

export interface SweepResult {
	lifecycle: LifecycleTransition[];
	approvalsExpired: number;
	dispatched: string[];
}

export class Scheduler {
	private readonly store: ControlStore;
	private readonly dispatcher: Dispatcher;
	private readonly intervalMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor(opts: SchedulerOptions) {
		this.store = opts.store;
		this.dispatcher = opts.dispatcher;
		this.intervalMs = opts.intervalMs ?? 60_000;
	}

	/** Run every maintenance job once. Lifecycle first so a just-expired unit is
	 * not dispatched this tick; approvals next; dispatch last. */
	async sweep(): Promise<SweepResult> {
		const lifecycle = this.store.sweepLifecycle();
		const approvalsExpired = this.store.expireApprovals();
		const dispatched = await this.dispatcher.tick();
		return { lifecycle, approvalsExpired, dispatched };
	}

	/** Begin the automatic interval loop. Overlapping sweeps are suppressed. */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			if (this.running) return;
			this.running = true;
			void this.sweep().finally(() => {
				this.running = false;
			});
		}, this.intervalMs);
		// Do not keep the process alive solely for the scheduler timer.
		this.timer.unref?.();
	}

	/** Stop the automatic loop. In-flight sweeps are allowed to finish. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}
