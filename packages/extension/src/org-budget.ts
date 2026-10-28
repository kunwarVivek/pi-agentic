/**
 * org-budget: meter provider usage into the control plane after every turn and
 * abort the session when the unit runs over budget (SPEC FR6). Metering rolls
 * usage into the unit's `used`; the control store flags exhausted dimensions.
 *
 * Pi's runner catches every non-tool_call handler throw, so a throw can never
 * stop the session: enforcement is `ctx.abort()`.
 */

import type { Budget } from "pi-agentic-core";
import type { OrgRuntime } from "./bootstrap.ts";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent, Usage } from "./pi-api.ts";

const nonNegative = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Map a Pi assistant `Usage` to a Budget delta. Tokens are `totalTokens` or the
 * sum of input/output/cacheRead/cacheWrite; cost is `cost.total`. Non-finite or
 * negative values count as zero.
 */
export function usageToBudget(usage: Usage | undefined, wallClockSec = 0): Budget {
	const wall = nonNegative(wallClockSec);
	if (!usage) return { tokens: 0, costUsd: 0, wallClockSec: wall };
	const total = nonNegative(usage.totalTokens);
	const tokens = total > 0 ? total : nonNegative(usage.input) + nonNegative(usage.output) + nonNegative(usage.cacheRead) + nonNegative(usage.cacheWrite);
	return { tokens, costUsd: nonNegative(usage.cost?.total), wallClockSec: wall };
}

export interface BudgetHookState {
	/** Set once the session has been aborted so we only abort/report once. */
	tripped: boolean;
	/** `turn_start.timestamp` (epoch ms) of the turn in flight, if any. */
	turnStartMs: number | null;
}

function notify(ctx: ExtensionContext, message: string): void {
	try {
		ctx.ui?.notify?.(message, "error");
	} catch {
		// Notification is best-effort; the abort below is what enforces.
	}
}

function trip(ctx: ExtensionContext, state: BudgetHookState, message: string): void {
	if (state.tripped) return;
	state.tripped = true;
	notify(ctx, message);
	ctx.abort();
}

export async function handleTurnEnd(
	runtime: OrgRuntime,
	event: TurnEndEvent,
	ctx: ExtensionContext,
	state: BudgetHookState,
	nowMs: number,
): Promise<void> {
	const client = runtime.client;
	const startMs = state.turnStartMs;
	state.turnStartMs = null;
	// Fail closed: a turn we cannot meter is a turn we cannot prove is within budget.
	if (!client) {
		trip(ctx, state, `org-budget: no control-plane client (${runtime.failure ?? "not connected"}); cannot meter, aborting session`);
		return;
	}
	if (!runtime.taskId) return;
	const wallClockSec = startMs === null ? 0 : Math.max(0, (nowMs - startMs) / 1000);
	const usage = event.message?.role === "assistant" ? event.message.usage : undefined;
	if (!usage) {
		trip(ctx, state, "org-budget: assistant message carries no usage; cannot meter, aborting session");
		return;
	}
	try {
		const result = await client.meter(runtime.taskId, usageToBudget(usage, wallClockSec));
		if (result.overBudget.length > 0) {
			const dims = result.overBudget.join(", ");
			const detail = result.escalation ? ` Escalated: ${result.escalation.question} (approval ${result.escalation.id}).` : "";
			trip(ctx, state, `org-budget: unit over budget on ${dims}; aborting session.${detail}`);
		}
	} catch (e) {
		// Fail closed: if usage cannot be metered we cannot prove we are within budget.
		trip(ctx, state, `org-budget: metering failed (${(e as Error).message}); aborting session`);
	}
}

export function installOrgBudget(pi: ExtensionAPI, runtime: OrgRuntime, clock: () => number = Date.now): void {
	if (!runtime.enabled) return;
	const state: BudgetHookState = { tripped: false, turnStartMs: null };
	pi.on("turn_start", (event) => {
		state.turnStartMs = Number.isFinite(event.timestamp) ? event.timestamp : null;
	});
	pi.on("turn_end", (event, ctx) => handleTurnEnd(runtime, event, ctx, state, clock()));
}
