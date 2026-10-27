/**
 * org-policy: enforce the PDP on every tool call (deny by default, SPEC FR2)
 * and redact secrets from tool results (SPEC FR9).
 */

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type RealpathResolver, decideToolCall } from "./policy-hook.ts";
import { redactSecrets } from "./redact.ts";
import type { OrgRuntime } from "./bootstrap.ts";
import type { ExtensionAPI } from "./pi-api.ts";

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
			tail.push(abs.slice(parent.length + 1));
			abs = parent;
		}
	}
}

export function installOrgPolicy(pi: ExtensionAPI, runtime: OrgRuntime, realpath: RealpathResolver = nearestRealpath): void {
	if (!runtime.enabled) return;

	pi.on("tool_call", (event) => {
		const client = runtime.client;
		if (!client) return { block: true, reason: "org-policy: control plane not ready" };
		return decideToolCall(event, { client, realpath });
	});

	pi.on("tool_result", (event) => {
		for (const part of event.content) {
			if (part.type === "text") part.text = redactSecrets(part.text);
		}
	});
}
