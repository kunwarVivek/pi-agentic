/**
 * org-trust: decide project trust for org worker sessions (SPEC: workers run
 * non-interactively, so they must not block on a trust prompt). Only personal
 * / -e extensions participate in project_trust, and the first decisive answer
 * wins.
 *
 * SPEC §5: trust only manifest-listed dirs. A cwd is trusted iff it lies inside
 * a canonicalized dir of the unit manifest's `trust` list. Filesystem path
 * grants do NOT imply trust (a unit that can write its workspace could plant
 * `.pi/extensions` there). Anything else is untrusted (fail closed).
 */

import { pathMatches } from "pi-agentic-core";
import type { OrgRuntime } from "./bootstrap.ts";
import type { ExtensionAPI, ProjectTrustEvent, TrustDecision } from "./pi-api.ts";

/** Pure decision over a loaded manifest: trust only a cwd inside a listed `trust` dir. */
export function decideTrust(runtime: OrgRuntime, cwd: string, realpath: (p: string) => string): TrustDecision {
	const manifest = runtime.manifest;
	if (!runtime.client || !manifest) return { trusted: "no" };
	try {
		const here = realpath(cwd);
		return manifest.trust.some((dir) => pathMatches(`${realpath(dir).replace(/\/+$/, "")}/**`, here)) ? { trusted: "yes" } : { trusted: "no" };
	} catch {
		return { trusted: "no" };
	}
}

export function installOrgTrust(
	pi: ExtensionAPI,
	runtime: OrgRuntime,
	realpath: (p: string) => string = (p) => p,
): void {
	if (!runtime.enabled) return;
	// Pi fires project_trust BEFORE session_start, so connect here; a failed
	// connect leaves the project untrusted (fail closed).
	pi.on("project_trust", async (event: ProjectTrustEvent) => {
		try {
			await runtime.connect();
		} catch {
			return { trusted: "no" };
		}
		return decideTrust(runtime, event.cwd, realpath);
	});
}
