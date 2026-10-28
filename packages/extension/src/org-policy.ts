/**
 * org-policy: enforce the PDP on every tool call (deny by default, SPEC FR2)
 * and redact secrets from tool results (SPEC FR9).
 */

import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { type RealpathResolver, decideToolCall } from "./policy-hook.ts";
import { REDACTION, redactSecrets, shouldRedactValue } from "./redact.ts";
import type { OrgRuntime } from "./bootstrap.ts";
import { sandboxShellCall } from "./sandbox.ts";
import type { ExtensionAPI, JsonValue } from "./pi-api.ts";

/** Resolve to an absolute real path; fall back to the nearest existing ancestor. */
export function nearestRealpath(p: string): string {
	let abs = resolve(p);
	// Walk up until a component exists, then realpath that and re-append the tail.
	const tail: string[] = [];
	for (;;) {
		try {
			const real = realpathSync(abs);
			return tail.length ? resolve(real, ...tail.toReversed()) : real;
		} catch {
			const parent = dirname(abs);
			if (parent === abs) return resolve(p); // reached root; give up to absolute
			tail.push(basename(abs));
			abs = parent;
		}
	}
}

export function installOrgPolicy(pi: ExtensionAPI, runtime: OrgRuntime, realpath: RealpathResolver = nearestRealpath): void {
	if (!runtime.enabled) return;

	pi.on("tool_call", async (event, ctx) => {
		const client = runtime.client;
		if (!client) return { block: true, reason: `org-policy: ${runtime.failure ?? "control plane not ready"}` };
		try {
			const protectedProjectDirs = runtime.dev ? undefined : [ctx.cwd, ...(runtime.manifest?.trust ?? [])];
			const decision = await decideToolCall(event, { client, realpath, cwd: ctx.cwd, ...(protectedProjectDirs ? { protectedProjectDirs } : {}) });
			if (decision.block) return decision;
			// Allowed shell call: confine it to the OS sandbox before Pi executes it (ADR-0002).
			const unsafe = sandboxShellCall({
				toolName: event.toolName,
				input: event.input,
				mode: runtime.shell,
				grants: client.effectiveGrants(),
				workspace: realpath(ctx.cwd),
				unitId: runtime.unitId,
				taskId: runtime.taskId,
			});
			return unsafe === null ? decision : { block: true, reason: `org-policy: ${unsafe}` };
		} catch (e) {
			return { block: true, reason: `org-policy: ${e instanceof Error ? e.message : String(e)}` };
		}
	});

	// Pi hands handlers a shallow copy, so redaction must be RETURNED, and
	// returning `content` alone would drop `structuredContent`: return both (FR9).
	pi.on("tool_result", (event) => {
		const secrets = runtime.secretValues();
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			const text = redactSecrets(redactLiterals(part.text, secrets));
			if (text === part.text) return part;
			changed = true;
			return { ...part, text };
		});
		let structuredContent = event.structuredContent;
		if (structuredContent !== undefined) {
			const r = redactJson(structuredContent, undefined, secrets);
			if (r !== structuredContent) {
				structuredContent = r;
				changed = true;
			}
		}
		if (!changed) return;
		return structuredContent === undefined ? { content } : { content, structuredContent };
	});
}

/** Replace every literal occurrence of a declared secret value (longest first) with the redaction marker. */
export function redactLiterals(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const s of secrets) if (s.length > 0) out = out.replaceAll(s, REDACTION);
	return out;
}

/**
 * Redact every string leaf of a JSON value, and any scalar stored under a sensitive
 * key (`{password: "x"}`); returns the same reference when unchanged. `key` is the
 * enclosing property name, inherited by array elements.
 */
export function redactJson(v: JsonValue, key?: string, secrets: readonly string[] = []): JsonValue {
	if (typeof v === "string") {
		const r = redactSecrets(redactLiterals(v, secrets));
		return key !== undefined && r === v && shouldRedactValue(key, v) ? REDACTION : r;
	}
	if (typeof v === "number") return key !== undefined && shouldRedactValue(key, v) ? REDACTION : v;
	if (Array.isArray(v)) {
		let out: JsonValue[] | null = null;
		v.forEach((item, i) => {
			const r = redactJson(item, key, secrets);
			if (r !== item) (out ??= v.slice())[i] = r;
		});
		return out ?? v;
	}
	if (v !== null && typeof v === "object") {
		let out: { [key: string]: JsonValue } | null = null;
		for (const [k, item] of Object.entries(v)) {
			const r = redactJson(item, k, secrets);
			if (r !== item) Object.defineProperty((out ??= { ...v }), k, { value: r, enumerable: true, writable: true, configurable: true });
		}
		return out ?? v;
	}
	return v;
}
