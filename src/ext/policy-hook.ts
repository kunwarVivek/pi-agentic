/**
 * Map a Pi tool_call event into a resolved ToolRequest for the PDP, then make a
 * block decision. Pure given the realpath resolver so it is unit-testable
 * (SPEC FR2, ADR-0002 default-deny).
 *
 * Path arguments are resolved to absolute real paths before matching, so a unit
 * cannot escape its write scope via `..` or a symlink. Paths that do not yet
 * exist (a file about to be written) resolve their nearest existing ancestor,
 * which is sufficient because path grants are prefix patterns.
 */

import { FILE_TOOLS } from "../core/policy.ts";
import type { ControlClient } from "./control-client.ts";
import type { ToolCallEvent, ToolCallDecision } from "./pi-api.ts";

/** Resolve a path argument to an absolute real path. */
export type RealpathResolver = (p: string) => string;

export interface PolicyHookDeps {
	client: ControlClient;
	realpath: RealpathResolver;
	/** Tools that are always allowed (never touch files, never need a grant). */
	freeTools?: ReadonlySet<string>;
}

const DEFAULT_FREE = new Set<string>(["org_delegate", "org_complete", "org_escalate", "org_status"]);

/** Extract the resolved path + mode a file tool call will touch, if any. */
export function fileAccess(
	toolName: string,
	input: Record<string, unknown>,
	realpath: RealpathResolver,
): { path: string; mode: "r" | "rw" } | null {
	const spec = FILE_TOOLS[toolName];
	if (!spec) return null;
	const raw = input[spec.arg];
	if (typeof raw !== "string" || raw.length === 0) return null;
	return { path: realpath(raw), mode: spec.mode };
}

export function decideToolCall(event: ToolCallEvent, deps: PolicyHookDeps): ToolCallDecision {
	const free = deps.freeTools ?? DEFAULT_FREE;
	if (free.has(event.toolName)) return { block: false };

	// bash is denied unless the unit explicitly holds tool:bash (SPEC FR2).
	const access = fileAccess(event.toolName, event.input, deps.realpath);
	const paths = access ? [access] : [];

	const decision = deps.client.decide({ toolName: event.toolName, paths });
	if (!decision.allow) {
		return { block: true, reason: `org-policy: ${decision.reason}` };
	}
	return { block: false };
}
