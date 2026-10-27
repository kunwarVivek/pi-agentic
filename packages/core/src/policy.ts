/**
 * Policy decision point (PDP). Pure: callers resolve real paths before asking.
 * Default deny (SPEC FR2, ADR-0002).
 */
import { type Grant, grantCovered, pathMatches } from "./grants.ts";

export interface ToolRequest {
	toolName: string;
	/** Absolute, realpath-resolved paths the call will touch, with access mode. */
	paths: ReadonlyArray<{ path: string; mode: "r" | "rw" }>;
}

export type Decision = { allow: true } | { allow: false; reason: string };

/** Built-in file tools and the access mode their path argument needs. */
export const FILE_TOOLS: Readonly<Record<string, { arg: string; mode: "r" | "rw" }>> = {
	read: { arg: "path", mode: "r" },
	grep: { arg: "path", mode: "r" },
	find: { arg: "path", mode: "r" },
	ls: { arg: "path", mode: "r" },
	write: { arg: "path", mode: "rw" },
	edit: { arg: "path", mode: "rw" },
};

export function pathAllowed(grants: readonly Grant[], path: string, mode: "r" | "rw"): boolean {
	return grants.some(
		(g) => g.kind === "path" && (mode === "r" || g.mode === "rw") && pathMatches(g.pattern, path),
	);
}

export function decide(grants: readonly Grant[], req: ToolRequest): Decision {
	if (!grantCovered({ kind: "tool", name: req.toolName }, grants)) {
		return { allow: false, reason: `tool '${req.toolName}' not granted` };
	}
	for (const { path, mode } of req.paths) {
		if (!pathAllowed(grants, path, mode)) {
			return { allow: false, reason: `${mode === "rw" ? "write" : "read"} access to '${path}' not granted` };
		}
	}
	return { allow: true };
}
