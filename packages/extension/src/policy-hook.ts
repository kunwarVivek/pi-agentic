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

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Decision, FILE_TOOLS, type ToolRequest, canonicalizePathGrants, decide } from "pi-agentic-core";
import type { ControlClient } from "pi-agentic-control-plane";
import type { ToolCallEvent, ToolCallDecision } from "./pi-api.ts";

/** Resolve a path argument to an absolute real path. */
export type RealpathResolver = (p: string) => string;

export interface PolicyHookDeps {
	client: ControlClient;
	realpath: RealpathResolver;
	/** The tool's working directory (Pi `ctx.cwd`); relative paths resolve against it. */
	cwd: string;
	/** Home directory for `~` expansion (defaults to os.homedir()). */
	homeDir?: string;
	/** Tools that are always allowed (never touch files, never need a grant). */
	freeTools?: ReadonlySet<string>;
	/**
	 * Project dirs (manifest `trust` list + cwd) whose `.pi/` and `.agents/` trees are
	 * write-protected regardless of path grants: a planted project extension would load
	 * unsandboxed on the next trusted session. Unset (dev mode): no protection.
	 */
	protectedProjectDirs?: readonly string[];
}

const DEFAULT_FREE = new Set<string>(["org_delegate", "org_complete", "org_escalate"]);

/** Same class Pi 1.4.0 utils/paths normalizes to a plain space. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Resolve a tool path argument to the absolute path Pi's built-in tools will
 * actually touch. Mirrors Pi 1.4.0 `resolveToCwd` (utils/paths normalizePath):
 * unicode spaces → " ", a leading "@" is stripped, "~" / "~/" expand to home,
 * file:// URLs become paths, and relative paths resolve against the tool cwd.
 * Diverging from the host here is a policy bypass ("@/etc/passwd" would be
 * checked as "<cwd>/@/etc/passwd" but read as "/etc/passwd").
 */
export function resolveToolPath(raw: string, cwd: string, homeDir: string = homedir()): string {
	let p = raw.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = homeDir;
	else if (p.startsWith("~/")) p = join(homeDir, p.slice(2));
	else if (/^file:\/\//.test(p)) p = fileURLToPath(p);
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/**
 * Extract the resolved path + mode a file tool call will touch, if any.
 * Returns null for non-file tools. grep/find/ls default a missing or empty path
 * to the cwd (as Pi does). Any other missing, empty or non-string path THROWS:
 * a call we cannot map to a path must never fall through to a tool-grant-only
 * decision (fail closed, SPEC FR2).
 */
export function fileAccess(
	toolName: string,
	input: Record<string, unknown>,
	realpath: RealpathResolver,
	base: { cwd: string; homeDir?: string },
): { path: string; mode: "r" | "rw" } | null {
	const spec = Object.hasOwn(FILE_TOOLS, toolName) ? FILE_TOOLS[toolName] : undefined;
	if (!spec) return null;
	let raw = input?.[spec.arg];
	if (spec.optional && (raw === undefined || raw === "")) raw = ".";
	if (typeof raw !== "string" || raw.length === 0) {
		throw new Error(`file tool '${toolName}' has no string '${spec.arg}' argument`);
	}
	return { path: realpath(resolveToolPath(raw, base.cwd, base.homeDir)), mode: spec.mode };
}

/**
 * Pi 1.4.0's MCP resource tools (core/mcp-servers.js) are not namespaced; the
 * server they reach is their `server` argument. `read_mcp_resource` requires it;
 * the list tools reach EVERY server when it is absent, which needs `mcp:*`.
 * Throws (deny) on a read call without a string server.
 */
export function mcpResourceServers(toolName: string, input: Record<string, unknown>): string[] | null {
	if (toolName !== "read_mcp_resource" && toolName !== "list_mcp_resources" && toolName !== "list_mcp_resource_templates") {
		return null;
	}
	const server = input?.server;
	if (typeof server === "string" && server.length > 0) return [server];
	if (toolName === "read_mcp_resource" || (server !== undefined && server !== null && server !== "")) {
		throw new Error(`MCP resource tool '${toolName}' has no usable string 'server' argument`);
	}
	return ["*"];
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The protected `<dir>/.pi` or `<dir>/.agents` root containing `path`, if any. */
function protectedProjectPath(path: string, deps: PolicyHookDeps): string | null {
	for (const dir of deps.protectedProjectDirs ?? []) {
		const base = deps.realpath(dir).replace(/\/+$/, "");
		for (const sub of PROTECTED_SUBDIRS) {
			const root = `${base}/${sub}`;
			if (path === root || path.startsWith(`${root}/`)) return root;
		}
	}
	return null;
}

const PROTECTED_SUBDIRS = [".pi", ".agents"];

/**
 * Decide a tool call and audit the decision through the control plane. Every
 * failure (unmappable path, PDP throw, audit failure) blocks: default deny.
 */
export async function decideToolCall(event: ToolCallEvent, deps: PolicyHookDeps): Promise<ToolCallDecision> {
	const free = deps.freeTools ?? DEFAULT_FREE;
	// Free org_* tools are audited by their own control-plane verbs, not per call.
	if (free.has(event.toolName)) return { block: false };

	let req: ToolRequest = { toolName: event.toolName, paths: [] };
	let decision: Decision;
	try {
		// bash is denied unless the unit explicitly holds tool:bash (SPEC FR2).
		const access = fileAccess(event.toolName, event.input, deps.realpath, deps);
		const mcpServers = mcpResourceServers(event.toolName, event.input);
		req = { toolName: event.toolName, paths: access ? [access] : [], ...(mcpServers ? { mcpServers } : {}) };
		const planted = access?.mode === "rw" ? protectedProjectPath(access.path, deps) : null;
		if (planted) throw new Error(`write to project resource ${planted} is forbidden (planting .pi/.agents code)`);
		// Grants are canonicalized with the same resolver as request paths so a
		// symlinked grant root matches; a resolver throw lands in the catch (deny).
		decision = decide(canonicalizePathGrants(deps.client.effectiveGrants(), deps.realpath), req);
	} catch (e) {
		decision = { allow: false, reason: `policy evaluation failed: ${errMessage(e)}` };
	}

	try {
		await deps.client.recordDecision(req, decision);
	} catch (e) {
		return { block: true, reason: `org-policy: audit failed (${errMessage(e)}); blocking` };
	}
	if (!decision.allow) return { block: true, reason: `org-policy: ${decision.reason}` };
	return { block: false };
}
