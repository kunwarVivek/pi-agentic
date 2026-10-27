/**
 * org-delegate: expose the control-plane verbs as Pi tools so an agent can
 * delegate work to a subordinate unit, complete its own task, and escalate for
 * a human decision (SPEC FR3/FR4/FR5). Tools fail closed: when the control
 * client is not ready they return an error result.
 */

import { parseGrants } from "@agentic-pi/core";
import type { Budget } from "@agentic-pi/core";
import type { Contract } from "@agentic-pi/core";
import type { OrgRuntime } from "./bootstrap.ts";
import type { ExtensionAPI, ToolResult } from "./pi-api.ts";

function text(s: string, isError = false): ToolResult {
	return { content: [{ type: "text", text: s }], isError };
}

function asBudget(v: unknown): Budget {
	const o = (v ?? {}) as Record<string, unknown>;
	const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
	return { tokens: num(o.tokens), costUsd: num(o.costUsd), wallClockSec: num(o.wallClockSec) };
}

const BUDGET_SCHEMA = {
	type: "object",
	properties: {
		tokens: { type: "number", minimum: 0 },
		costUsd: { type: "number", minimum: 0 },
		wallClockSec: { type: "number", minimum: 0 },
	},
	additionalProperties: false,
} as const;

export function installOrgDelegate(pi: ExtensionAPI, runtime: OrgRuntime): void {
	if (!runtime.enabled) return;

	pi.registerTool({
		name: "org_delegate",
		label: "Delegate to a unit",
		description:
			"Delegate a task to a subordinate unit. Grants must be a subset of your own; the delegated budget is reserved against yours. Returns the new task id.",
		parameters: {
			type: "object",
			properties: {
				toUnit: { type: "string", description: "Target unit id (must be a descendant or an explicit delegate target)." },
				goal: { type: "string", description: "What the unit must achieve." },
				contract: { type: "object", description: "Gate contract: { schema, rules?, judge? }." },
				grants: { type: "array", items: { type: "string" }, description: "Grant strings, e.g. 'path:rw:/srv/x/**'." },
				budget: BUDGET_SCHEMA,
			},
			required: ["toUnit", "goal", "contract", "budget"],
			additionalProperties: false,
		},
		execute: async (_id, params) => {
			const client = runtime.client;
			if (!client) return text("org-delegate: control plane not ready", true);
			const p = params as {
				toUnit: string;
				goal: string;
				contract: Contract;
				grants?: string[];
				budget: unknown;
			};
			const grants = p.grants ? parseGrants(p.grants) : undefined;
			const result = await client.delegate({
				toUnit: p.toUnit,
				goal: p.goal,
				contract: p.contract,
				...(grants ? { grants } : {}),
				budget: asBudget(p.budget),
			});
			if (!result.ok) return text(`delegation denied (${result.code}): ${result.reason}`, true);
			return text(`delegated task ${result.taskId} to ${p.toUnit}`);
		},
	});

	pi.registerTool({
		name: "org_complete",
		label: "Complete current task",
		description:
			"Submit your task's artifact for gate evaluation. If the gates pass the task is done; if they fail it is retried or escalated.",
		parameters: {
			type: "object",
			properties: { artifact: { description: "The result object to be gate-checked and stored." } },
			required: ["artifact"],
			additionalProperties: false,
		},
		execute: async (_id, params) => {
			const client = runtime.client;
			if (!client) return text("org-complete: control plane not ready", true);
			if (!runtime.taskId) return text("org-complete: no current task to complete", true);
			const p = params as { artifact: unknown };
			const r = await client.completeTask(runtime.taskId, p.artifact);
			if (r.ok) return text(`task ${runtime.taskId} done (artifact ${r.artifactHash.slice(0, 12)})`);
			if (r.status === "error") return text(`completion error: ${r.reason}`, true);
			const why = r.gate.pass ? "" : `${r.gate.stage}: ${r.gate.reasons.join("; ")}`;
			return text(`gate ${r.status} on attempt ${r.attempts}: ${why}`, true);
		},
	});

	pi.registerTool({
		name: "org_escalate",
		label: "Escalate for a decision",
		description: "Open an approval request routed to the owning human. Blocks the task until resolved or the approval expires.",
		parameters: {
			type: "object",
			properties: {
				question: { type: "string" },
				options: { type: "array", items: { type: "string" } },
			},
			required: ["question", "options"],
			additionalProperties: false,
		},
		execute: async (_id, params) => {
			const client = runtime.client;
			if (!client) return text("org-escalate: control plane not ready", true);
			if (!runtime.taskId) return text("org-escalate: no current task to escalate", true);
			const p = params as { question: string; options: string[] };
			const a = await client.escalate(runtime.taskId, p.question, p.options);
			return text(`escalated: approval ${a.id} routed to ${a.owner}, expires ${a.expiresAt}`);
		},
	});
}
