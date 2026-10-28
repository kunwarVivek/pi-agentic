/**
 * The org extension for pi-durable: parity with the Pi extension (policy,
 * redaction, budget metering, org_* tools) on pi-durable's own hook API.
 *
 *  - beforeTool (PEP): the shared `decideToolCall` (same path resolution, same
 *    core `decide`, same audited `recordDecision`); every failure blocks.
 *  - afterTool: redactSecrets / redactJson over output, structuredOutput,
 *    details and diagnostics.
 *  - afterResponse: one `client.meter` per model step; over budget (or a
 *    metering failure) trips the run: every later tool call is blocked and the
 *    conversation is aborted (the control plane escalates on first overrun).
 *  - org_delegate / org_complete / org_escalate call the ControlClient.
 */

import type { ControlClient } from "pi-agentic-control-plane";
import { parseGrants, type Budget, type Contract } from "pi-agentic-core";
import {
	asBudget,
	decideToolCall,
	redactJson,
	redactLiterals,
	redactSecrets,
	sandboxShellCall,
	usageToBudget,
	type RealpathResolver,
	type ShellMode,
} from "pi-agentic/shared";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	GenerationTask,
	hook,
	ToolTask,
	type Extension,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";

export const ORG_EXTENSION_NAME = "agentic-pi-org";

export interface OrgExtensionOptions {
	client: ControlClient;
	taskId: string;
	/** Working directory relative tool paths resolve against. */
	cwd: string;
	realpath: RealpathResolver;
	/** This worker's unit id (names the bwrap scratch/audit identity). */
	unitId: string;
	/** How a granted shell tool call runs (bwrap rewrite, explicit unsandboxed, or blocked). */
	shell: ShellMode;
	/** Literal secret values (manifest `secrets` env + auth.json strings) redacted from every tool result. */
	secrets: readonly string[];
	/** Injected clock (epoch ms) for wall-clock metering. */
	now: () => number;
	/** Stop the run (called at most once, never awaited from inside a hook). */
	abortRun: () => void;
}

/** What the run observed; read by the runner after the submission settles. */
export interface OrgRunState {
	/** Set once the run was stopped for budget or metering failure. */
	tripped: boolean;
	tripReason: string | null;
	overBudget: Array<keyof Budget>;
	escalationId: string | null;
	/** org_complete passed the gates. */
	completed: boolean;
	/** Model steps metered. */
	meteredSteps: number;
}

const text = (s: string, isError = false): ToolExecutionResult => ({ output: [{ type: "text", text: s }], ...(isError ? { isError: true } : {}) });
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createOrgExtension(opts: OrgExtensionOptions): { extension: Extension; state: OrgRunState } {
	const { client, taskId } = opts;
	const state: OrgRunState = { tripped: false, tripReason: null, overBudget: [], escalationId: null, completed: false, meteredSteps: 0 };
	let stepStartMs: number | null = null;

	const trip = (reason: string): void => {
		if (state.tripped) return;
		state.tripped = true;
		state.tripReason = reason;
		opts.abortRun();
	};

	const orgDelegate = defineTool({
		name: "org_delegate",
		description:
			"Delegate a task to a subordinate unit. Grants must be a subset of your own; the delegated budget is reserved against yours. Returns the new task id.",
		parameters: Type.Object({
			toUnit: Type.String({ description: "Target unit id (must be a descendant or an explicit delegate target)." }),
			goal: Type.String({ description: "What the unit must achieve." }),
			contract: Type.Record(Type.String(), Type.Unknown(), { description: "Gate contract: { schema, rules?, judge? }." }),
			grants: Type.Optional(Type.Array(Type.String(), { description: "Grant strings, e.g. 'path:rw:/srv/x/**'." })),
			budget: Type.Object({
				tokens: Type.Optional(Type.Number({ minimum: 0 })),
				costUsd: Type.Optional(Type.Number({ minimum: 0 })),
				wallClockSec: Type.Optional(Type.Number({ minimum: 0 })),
			}),
		}),
		async execute(args) {
			const grants = args.grants ? parseGrants(args.grants) : undefined;
			const result = await client.delegate({
				toUnit: args.toUnit,
				goal: args.goal,
				contract: args.contract as unknown as Contract,
				...(grants ? { grants } : {}),
				budget: asBudget(args.budget),
			});
			if (!result.ok) return text(`delegation denied (${result.code}): ${result.reason}`, true);
			return text(`delegated task ${result.taskId} to ${args.toUnit}`);
		},
	});

	const orgComplete = defineTool({
		name: "org_complete",
		description: "Submit your task's artifact for gate evaluation. If the gates pass the task is done; if they fail it is retried or escalated.",
		parameters: Type.Object({ artifact: Type.Unknown({ description: "The result object to be gate-checked and stored." }) }),
		async execute(args) {
			const r = await client.completeTask(taskId, args.artifact);
			if (r.ok) {
				state.completed = true;
				// Done: end the run without another model request.
				return { ...text(`task ${taskId} done (artifact ${r.artifactHash.slice(0, 12)})`), control: { terminate: true } };
			}
			if (r.status === "error") return text(`completion error: ${r.reason}`, true);
			const why = r.gate.pass ? "" : `${r.gate.stage}: ${r.gate.reasons.join("; ")}`;
			return text(`gate ${r.status} on attempt ${r.attempts}: ${why}`, true);
		},
	});

	const orgEscalate = defineTool({
		name: "org_escalate",
		description: "Open an approval request routed to the owning human. Blocks the task until resolved or the approval expires.",
		parameters: Type.Object({ question: Type.String(), options: Type.Array(Type.String()) }),
		async execute(args) {
			const a = await client.escalate(taskId, args.question, args.options);
			return { ...text(`escalated: approval ${a.id} routed to ${a.owner}, expires ${a.expiresAt}`), control: { terminate: true } };
		},
	});

	const extension = defineExtension({
		name: ORG_EXTENSION_NAME,
		tools: [orgDelegate, orgComplete, orgEscalate],
		hooks: [
			hook(ToolTask, {
				async beforeTool(call) {
					if (state.tripped) return { block: `org-policy: run stopped (${state.tripReason})` };
					try {
						const d = await decideToolCall(
							{ toolName: call.name, input: call.arguments as Record<string, unknown> },
							{ client, realpath: opts.realpath, cwd: opts.cwd },
						);
						if (d.block) return { block: d.reason ?? "org-policy: blocked" };
						// Allowed shell call: confine it to the OS sandbox before pi-durable runs it.
						const input = structuredClone(call.arguments) as Record<string, unknown>;
						const unsafe = sandboxShellCall({
							toolName: call.name,
							input,
							mode: opts.shell,
							grants: client.effectiveGrants(),
							workspace: opts.realpath(opts.cwd),
							unitId: opts.unitId,
							taskId,
						});
						if (unsafe !== null) return { block: `org-policy: ${unsafe}` };
						return input.command !== (call.arguments as Record<string, unknown>).command ? { arguments: input as Record<string, JsonValue> } : undefined;
					} catch (e) {
						return { block: `org-policy: ${errMessage(e)}` };
					}
				},
				afterTool(_call, result) {
					return redactResult(result, opts.secrets);
				},
			}),
			hook(GenerationTask, {
				async beforeRequest() {
					stepStartMs = opts.now();
					if (state.tripped) return undefined;
					// Track grants / status / budget like the Pi extension's turn_start refresh; a
					// stale cache is never trusted, so a failed refresh stops the run.
					try {
						await client.refresh();
					} catch (e) {
						trip(`refresh failed (${errMessage(e)})`);
					}
					return undefined;
				},
				async afterResponse(message) {
					const startMs = stepStartMs;
					stepStartMs = null;
					const wallClockSec = startMs === null ? 0 : Math.max(0, (opts.now() - startMs) / 1000);
					try {
						const result = await client.meter(taskId, usageToBudget(message.usage, wallClockSec));
						state.meteredSteps++;
						if (result.overBudget.length > 0) {
							state.overBudget = result.overBudget;
							if (result.escalation) state.escalationId = result.escalation.id;
							trip(`over budget on ${result.overBudget.join(", ")}`);
						}
					} catch (e) {
						// Fail closed: usage we cannot meter is usage we cannot bound.
						trip(`metering failed (${errMessage(e)})`);
					}
				},
			}),
		],
	});

	return { extension, state };
}

/** Redact a tool result; returns undefined when nothing changed. */
export function redactResult(result: ToolExecutionResult, secrets: readonly string[] = []): ToolExecutionResult | undefined {
	let changed = false;
	const output = result.output?.map((part) => {
		if (part.type !== "text") return part;
		const t = redactSecrets(redactLiterals(part.text, secrets));
		if (t === part.text) return part;
		changed = true;
		return { ...part, text: t };
	});
	let structuredOutput = result.structuredOutput;
	if (structuredOutput !== undefined) {
		const r = redactJson(structuredOutput as never, undefined, secrets) as JsonValue;
		if (r !== structuredOutput) {
			structuredOutput = r;
			changed = true;
		}
	}
	let details = result.details;
	if (details !== undefined) {
		const r = redactJson(details as never, undefined, secrets) as JsonValue;
		if (r !== details) {
			details = r;
			changed = true;
		}
	}
	const diagnostics = result.diagnostics?.map((d) => {
		const m = redactSecrets(redactLiterals(d.message, secrets));
		if (m === d.message) return d;
		changed = true;
		return { ...d, message: m };
	});
	if (!changed) return undefined;
	return {
		...result,
		...(output ? { output } : {}),
		...(structuredOutput !== undefined ? { structuredOutput } : {}),
		...(details !== undefined ? { details } : {}),
		...(diagnostics ? { diagnostics } : {}),
	};
}
