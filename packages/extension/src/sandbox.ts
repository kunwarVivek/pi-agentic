/**
 * Route Pi's bash tool through bubblewrap (ADR-0002, SPEC S6).
 *
 * Mechanism (verified against Pi 1.4.0): `tool_call.input` is the validated args
 * object the agent loop later passes to the tool's `execute`, and the extension
 * docs state handlers may mutate it. The built-in bash tool runs
 * `<shell> -c <command>`, so rewriting `input.command` to a single shell-quoted
 * `bwrap … /bin/bash -c '<original>'` line makes Pi execute the wrapper, with
 * the original command confined to one single-quoted argv word.
 * `createBashTool({spawnHook|operations})` is not importable here (no runtime
 * dependency on the host, ADR-0001).
 */

import { type Grant, SHELL_TOOLS } from "pi-agentic-core";
import { buildBwrapCommand } from "pi-agentic-deploy";
import type { ShellMode } from "./bootstrap.ts";

/** POSIX single-quote a word: `'` becomes `'\''`; newlines and everything else stay literal inside the quotes. */
export function shellQuote(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Join argv into one POSIX shell line that re-parses to exactly that argv. */
export function shellJoin(argv: readonly string[]): string {
	return argv.map(shellQuote).join(" ");
}

export interface ShellWrapInput {
	toolName: string;
	input: Record<string, unknown>;
	mode: ShellMode;
	grants: readonly Grant[];
	/** Real path of the tool cwd; becomes the sandbox workspace (always rw). */
	workspace: string;
	unitId: string;
	taskId: string | null;
}

/**
 * Apply the sandbox decision to an allowed shell tool call. Returns a block
 * reason, or null after (when sandboxing) rewriting `input.command` in place.
 */
export function sandboxShellCall(call: ShellWrapInput): string | null {
	if (!SHELL_TOOLS.includes(call.toolName)) return null;
	if (call.mode.mode === "unsandboxed") return null;
	if (call.mode.mode === "blocked") {
		return `${call.toolName} requires the OS sandbox (ORG_BWRAP=1) or explicit AGENTIC_PI_UNSANDBOXED_BASH=1; refusing to run unsandboxed`;
	}
	if (call.toolName !== "bash") return `${call.toolName} cannot be routed through bwrap; refusing to run unsandboxed`;
	const command = call.input.command;
	if (typeof command !== "string" || command.length === 0) return "bash call has no command string";
	try {
		const argv = buildBwrapCommand({
			grants: call.grants,
			command,
			workspace: call.workspace,
			...(call.mode.bwrapBin ? { bwrapBin: call.mode.bwrapBin } : {}),
			unitId: call.unitId,
			...(call.taskId ? { taskId: call.taskId } : {}),
		});
		call.input.command = shellJoin(argv);
		return null;
	} catch (e) {
		return `cannot build bwrap sandbox: ${e instanceof Error ? e.message : String(e)}`;
	}
}
