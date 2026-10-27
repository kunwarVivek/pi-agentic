/**
 * org-trust: decide project trust for org worker sessions (SPEC: workers run
 * non-interactively, so they must not block on a trust prompt). Only personal
 * / -e extensions participate in project_trust, and the first decisive answer
 * wins.
 *
 * A unit's `path` is an org path (e.g. "sales/emea"), not a filesystem path, so
 * trust is grounded in the unit's actual filesystem grants: we trust a cwd only
 * when it lies within a directory the unit holds a path grant for. Anything
 * else is untrusted (fail closed).
 */

import { pathMatches } from "@agentic-pi/core";
import type { OrgRuntime } from "./bootstrap.ts";
import type { ExtensionAPI, ProjectTrustEvent, TrustDecision } from "./pi-api.ts";

export function decideTrust(runtime: OrgRuntime, cwd: string, realpath: (p: string) => string): TrustDecision {
	const client = runtime.client;
	if (!client) return { trusted: "no" };
	const here = realpath(cwd);
	const grants = client.effectiveGrants();
	for (const g of grants) {
		if (g.kind === "path" && pathMatches(g.pattern, here)) return { trusted: "yes" };
	}
	return { trusted: "no" };
}

export function installOrgTrust(
	pi: ExtensionAPI,
	runtime: OrgRuntime,
	realpath: (p: string) => string = (p) => p,
): void {
	if (!runtime.enabled) return;
	pi.on("project_trust", (event: ProjectTrustEvent) => decideTrust(runtime, event.cwd, realpath));
}
