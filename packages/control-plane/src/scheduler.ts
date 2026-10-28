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
	/** Interval timer implementation (default: global setInterval, unref'd). Tests inject a manual one. */
	timer?: SchedulerTimer;
	/** Receives a failed sweep (default: console.error). A failure never escapes the timer. */
	onError?: (e: unknown) => void;
}

export interface SweepResult {
	lifecycle: LifecycleTransition[];
	approvalsExpired: number;
	dispatched: string[];
}

/** Injectable interval timer (tests drive ticks by hand; production uses the global timers). */
export interface SchedulerTimer {
	setInterval(fn: () => unknown, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

const REAL_TIMER: SchedulerTimer = {
	setInterval: (fn, ms) => {
		const h = setInterval(fn, ms);
		// Do not keep the process alive solely for the scheduler timer.
		h.unref?.();
		return h;
	},
	clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export class Scheduler {
	private readonly store: ControlStore;
	private readonly dispatcher: Dispatcher;
	private readonly intervalMs: number;
	private readonly timerImpl: SchedulerTimer;
	private readonly onError: (e: unknown) => void;
	private timer: unknown = null;
	private running = false;

	constructor(opts: SchedulerOptions) {
		this.store = opts.store;
		this.dispatcher = opts.dispatcher;
		this.intervalMs = opts.intervalMs ?? 60_000;
		this.timerImpl = opts.timer ?? REAL_TIMER;
		this.onError = opts.onError ?? ((e) => console.error("pi-control: scheduler sweep failed:", e));
	}

	/** Run every maintenance job once. Lifecycle first so a just-expired unit is
	 * not dispatched this tick; approvals next; dispatch last. */
	async sweep(): Promise<SweepResult> {
		const lifecycle = this.store.sweepLifecycle();
		const approvalsExpired = this.store.expireApprovals();
		const dispatched = await this.dispatcher.tick();
		return { lifecycle, approvalsExpired, dispatched };
	}

	/** Begin the automatic interval loop. Overlapping sweeps are suppressed; a failed sweep is reported, never thrown. */
	start(): void {
		if (this.timer) return;
		this.timer = this.timerImpl.setInterval(() => {
			if (this.running) return Promise.resolve();
			this.running = true;
			return this.sweep()
				.then(() => undefined)
				.catch((e: unknown) => {
					try {
						this.onError(e);
					} catch {
						// a failing reporter must not become an unhandled rejection either
					}
				})
				.finally(() => {
					this.running = false;
				});
		}, this.intervalMs);
	}

	/** Stop the automatic loop. In-flight sweeps are allowed to finish. */
	stop(): void {
		if (this.timer) {
			this.timerImpl.clearInterval(this.timer);
			this.timer = null;
		}
	}
}
