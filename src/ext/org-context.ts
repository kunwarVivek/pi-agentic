/**
 * org-context: inject the unit's identity, current task, grants and remaining
 * budget into the system prompt so the agent knows who it is and what it may do
 * (SPEC FR2 situational awareness). Read-only; never mutates control state.
 */

import { formatGrant } from "../core/grants.ts";
import type { OrgRuntime } from "./bootstrap.ts";
import type { ExtensionAPI } from "./pi-api.ts";

export function renderOrgContext(runtime: OrgRuntime): string {
	const client = runtime.client;
	if (!client) return "";
	const unit = client.unit();
	if (!unit) return "";
	const lines: string[] = [];
	lines.push(`You are operating as org unit **${unit.id}** (path ${unit.path}).`);
	if (unit.parent) lines.push(`Your parent unit is ${unit.parent}. Owner: ${unit.owner}.`);
	lines.push("");

	const grants = client.effectiveGrants();
	if (grants.length) {
		lines.push("Your effective grants (anything not listed is denied):");
		for (const g of grants) lines.push(`  - ${formatGrant(g)}`);
	} else {
		lines.push("You hold no grants: every tool call that needs one will be denied.");
	}
	lines.push("");

	const rb = client.remainingBudget();
	lines.push(`Remaining budget — tokens: ${rb.tokens}, cost: $${rb.costUsd}, wall-clock: ${rb.wallClockSec}s.`);

	const task = client.currentTask();
	if (task) {
		lines.push("");
		lines.push(`Current task ${task.id}: ${task.goal}`);
		lines.push("When finished, call org_complete with an artifact that satisfies the task contract.");
	}
	return lines.join("\n");
}

export function installOrgContext(pi: ExtensionAPI, runtime: OrgRuntime): void {
	if (!runtime.enabled) return;
	pi.on("before_agent_start", (event) => {
		const section = renderOrgContext(runtime);
		if (section) event.systemPromptOptions.sections.org_context = section;
	});
}
