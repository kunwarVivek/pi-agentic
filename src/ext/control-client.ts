/**
 * ControlClient: the surface the org extensions use to talk to the control
 * plane. Reads are served synchronously from a cached WorkerSnapshot so the
 * tool_call PDP can decide without a round-trip; mutations are async because a
 * socket-backed client must cross a process boundary.
 *
 * Two implementations share the derived read logic via BaseControlClient:
 *  - LocalControlClient: opens the ControlStore in-process (dev / single-host).
 *  - SocketControlClient (socket-client.ts): talks to a ControlServer.
 */

import { type Grant, effectiveGrants } from "../core/grants.ts";
import type { Budget } from "../core/manifest.ts";
import { type Decision, type ToolRequest, decide } from "../core/policy.ts";
import {
	type ApprovalRow,
	type CompleteResult,
	ControlStore,
	type DelegateResult,
	type MeterResult,
	type TaskRow,
	type UnitRow,
} from "../store/control.ts";

/** Read-only projection of control state a worker needs to run locally. */
export interface WorkerSnapshot {
	unit: UnitRow | null;
	task: TaskRow | null;
	remainingBudget: Budget;
}

/** Delegate input without `fromUnit`: the client supplies its own identity. */
export interface ClientDelegateInput {
	toUnit: string;
	goal: string;
	contract: import("../core/gates.ts").Contract;
	grants?: Grant[];
	budget: Budget;
	deadline?: string | null;
}

export interface ControlClient {
	readonly unitId: string;
	/** Current cached snapshot (sync). */
	snapshot(): WorkerSnapshot;
	/** Fetch a fresh snapshot and cache it. */
	refresh(): Promise<WorkerSnapshot>;
	currentTask(): TaskRow | null;
	unit(): UnitRow | null;
	/** Unit grants narrowed by the current task's grants (FR2). */
	effectiveGrants(): Grant[];
	/** PDP decision for a resolved tool request (local, sync). */
	decide(req: ToolRequest): Decision;
	remainingBudget(): Budget;
	delegate(input: ClientDelegateInput): Promise<DelegateResult>;
	completeTask(taskId: string, artifact: unknown): Promise<CompleteResult>;
	escalate(taskId: string, question: string, options: string[]): Promise<ApprovalRow>;
	meter(taskId: string, usage: Budget): Promise<MeterResult>;
	close(): void | Promise<void>;
}

const EMPTY_BUDGET: Budget = { tokens: 0, costUsd: 0, wallClockSec: 0 };

/** Shared derived reads over whatever snapshot() a subclass provides. */
export abstract class BaseControlClient implements ControlClient {
	abstract readonly unitId: string;
	abstract snapshot(): WorkerSnapshot;
	abstract refresh(): Promise<WorkerSnapshot>;
	abstract delegate(input: ClientDelegateInput): Promise<DelegateResult>;
	abstract completeTask(taskId: string, artifact: unknown): Promise<CompleteResult>;
	abstract escalate(taskId: string, question: string, options: string[]): Promise<ApprovalRow>;
	abstract meter(taskId: string, usage: Budget): Promise<MeterResult>;
	abstract close(): void | Promise<void>;

	currentTask(): TaskRow | null {
		return this.snapshot().task;
	}
	unit(): UnitRow | null {
		return this.snapshot().unit;
	}
	effectiveGrants(): Grant[] {
		const s = this.snapshot();
		if (!s.unit) return [];
		return effectiveGrants(s.unit.grants, s.task?.grants ?? undefined);
	}
	decide(req: ToolRequest): Decision {
		return decide(this.effectiveGrants(), req);
	}
	remainingBudget(): Budget {
		return this.snapshot().remainingBudget;
	}
}

/** In-process client: reads live from the store, so the snapshot is always current. */
export class LocalControlClient extends BaseControlClient {
	readonly unitId: string;
	private readonly taskId: string | null;
	private readonly store: ControlStore;

	constructor(args: { unitId: string; taskId: string | null; store: ControlStore }) {
		super();
		this.unitId = args.unitId;
		this.taskId = args.taskId;
		this.store = args.store;
	}

	static open(args: { unitId: string; taskId: string | null; dbPath: string }): LocalControlClient {
		return new LocalControlClient({ unitId: args.unitId, taskId: args.taskId, store: new ControlStore(args.dbPath) });
	}

	snapshot(): WorkerSnapshot {
		const unit = this.store.getUnit(this.unitId);
		const task = this.taskId ? this.store.getTask(this.taskId) : null;
		const remainingBudget = unit ? this.store.remainingBudget(this.unitId) : EMPTY_BUDGET;
		return { unit, task, remainingBudget };
	}

	refresh(): Promise<WorkerSnapshot> {
		return Promise.resolve(this.snapshot());
	}

	delegate(input: ClientDelegateInput): Promise<DelegateResult> {
		return Promise.resolve(
			this.store.delegate({
				fromUnit: this.unitId,
				toUnit: input.toUnit,
				goal: input.goal,
				contract: input.contract,
				...(input.grants ? { grants: input.grants } : {}),
				budget: input.budget,
				parentTask: this.taskId,
				...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
			}),
		);
	}

	completeTask(taskId: string, artifact: unknown): Promise<CompleteResult> {
		return this.store.completeTask(taskId, artifact);
	}

	escalate(taskId: string, question: string, options: string[]): Promise<ApprovalRow> {
		return Promise.resolve(this.store.escalate(taskId, question, options));
	}

	meter(taskId: string, usage: Budget): Promise<MeterResult> {
		return Promise.resolve(this.store.meter(taskId, usage));
	}

	close(): void {
		this.store.close();
	}
}
