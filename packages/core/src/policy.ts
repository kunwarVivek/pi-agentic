/**
 * Policy decision point (PDP). Pure: callers resolve real paths before asking.
 * Default deny (SPEC FR2, ADR-0002).
 */
import { type Grant, grantCovered, pathMatches } from "./grants.ts";

export interface ToolRequest {
	toolName: string;
	/** Absolute, realpath-resolved paths the call will touch, with access mode. */
	paths: ReadonlyArray<{ path: string; mode: "r" | "rw" }>;
	/**
	 * MCP server names the call reaches that are not encoded in `toolName`
	 * (resource tools take a `server` argument; `"*"` = every server). Each needs an
	 * `mcp:` grant. Namespaced `mcp__<server>__<tool>` tools are attributed by `decide`.
	 */
	mcpServers?: readonly string[];
}

export type Decision = { allow: true } | { allow: false; reason: string };

/** Pi 1.4.0 names MCP tools `mcp__<server>__<tool>`, every char but [A-Za-z0-9_] replaced by `_`. */
const MCP_PREFIX = "mcp__";
const sanitizeServer = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, "_");

/**
 * Every server a namespaced MCP tool name could belong to. Sanitising makes the
 * name ambiguous when the tool part contains `__` (server `a` + tool `b__c` vs
 * server `a_b` + tool `c`), so each split is a candidate and ALL must be granted
 * (fail closed). Returns null for non-MCP names and [] when no server can be read.
 */
export function mcpServerCandidates(toolName: string): string[] | null {
	if (!toolName.startsWith(MCP_PREFIX)) return null;
	const rest = toolName.slice(MCP_PREFIX.length);
	const out: string[] = [];
	for (let i = rest.indexOf("__"); i !== -1; i = rest.indexOf("__", i + 1)) {
		if (i > 0 && i + 2 < rest.length) out.push(rest.slice(0, i));
	}
	return out;
}

function mcpAllowed(grants: readonly Grant[], server: string): boolean {
	return grants.some(
		(g) => g.kind === "mcp" && (g.server === "*" || (server !== "*" && sanitizeServer(g.server) === sanitizeServer(server))),
	);
}

/**
 * Built-in file tools and the access mode their path argument needs. `optional`
 * tools default a missing/empty path to the working directory, exactly as Pi
 * 1.4.0 does (`resolveToCwd(path || ".", cwd)` in grep/find/ls).
 */
export const FILE_TOOLS: Readonly<Record<string, { arg: string; mode: "r" | "rw"; optional?: true }>> = {
	read: { arg: "path", mode: "r" },
	grep: { arg: "path", mode: "r", optional: true },
	find: { arg: "path", mode: "r", optional: true },
	ls: { arg: "path", mode: "r", optional: true },
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
	const candidates = mcpServerCandidates(req.toolName);
	if (candidates !== null && candidates.length === 0) {
		return { allow: false, reason: `MCP tool '${req.toolName}' cannot be attributed to a server; denied` };
	}
	for (const server of [...(candidates ?? []), ...(req.mcpServers ?? [])]) {
		if (!mcpAllowed(grants, server)) return { allow: false, reason: `mcp server '${server}' not granted` };
	}
	for (const { path, mode } of req.paths) {
		if (!pathAllowed(grants, path, mode)) {
			return { allow: false, reason: `${mode === "rw" ? "write" : "read"} access to '${path}' not granted` };
		}
	}
	return { allow: true };
}
