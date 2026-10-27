/**
 * org-budget: meter provider usage into the control plane after every turn and
 * abort the session when the unit runs over budget (SPEC FR6). Metering rolls
 * usage into the unit's `used`; the control store flags exhausted dimensions.
 */

import type { Budget } from "@agentic-pi/core";
import type { OrgRuntime } from "./bootstrap.ts";
import type { ExtensionAPI, ProviderUsage, TurnEndEvent } from "./pi-api.ts";

/** Map a provider usage report to a Budget delta. Missing fields count as zero. */
export function usageToBudget(usage: ProviderUsage | undefined): Budget {
	if (!usage) return { tokens: 0, costUsd: 0, wallClockSec: 0 };
	const tokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
	return {
		tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
		costUsd: Number.isFinite(usage.costUsd ?? 0) && (usage.costUsd ?? 0) > 0 ? (usage.costUsd as number) : 0,
		wallClockSec: 0,
	};
}

export interface BudgetHookState {
	/** Set once the unit has gone over budget so we only report it once. */
	tripped: boolean;
}

export async function handleTurnEnd(
	runtime: OrgRuntime,
	event: TurnEndEvent,
	state: BudgetHookState,
	onOverBudget: (dims: Array<keyof Budget>) => void,
): Promise<void> {
	const client = runtime.client;
	if (!client || !runtime.taskId) return;
	const delta = usageToBudget(event.usage);
	const result = await client.meter(runtime.taskId, delta);
	if (result.overBudget.length > 0 && !state.tripped) {
		state.tripped = true;
		onOverBudget(result.overBudget);
	}
}

export function installOrgBudget(pi: ExtensionAPI, runtime: OrgRuntime): void {
	if (!runtime.enabled) return;
	const state: BudgetHookState = { tripped: false };
	pi.on("turn_end", (event) => {
		void handleTurnEnd(runtime, event, state, (dims) => {
			throw new Error(`org-budget: unit over budget on ${dims.join(", ")}; aborting session`);
		});
	});
}
