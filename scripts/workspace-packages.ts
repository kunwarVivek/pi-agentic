/**
 * The publishable workspace packages, read from the root package.json `workspaces` and
 * returned in publish order (every package after the workspace packages it depends on).
 * Shared by release-check.ts and release.ts so there is one source for the order.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkspacePkg {
	name: string;
	version: string;
	/** Absolute package directory. */
	dir: string;
	/** Directory relative to the repo root, as `npm -w` expects it (e.g. `packages/core`). */
	rel: string;
	json: Record<string, any>;
}

export function loadWorkspacePackages(repo: string): WorkspacePkg[] {
	const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
	const all: WorkspacePkg[] = (root.workspaces as string[]).map((rel) => {
		const dir = join(repo, rel);
		const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		return { name: json.name, version: json.version, dir, rel, json };
	});
	const byName = new Map(all.map((p) => [p.name, p]));
	const ordered: WorkspacePkg[] = [];
	const state = new Map<string, "visiting" | "done">();
	const visit = (p: WorkspacePkg, path: string[]) => {
		if (state.get(p.name) === "done") return;
		if (state.get(p.name) === "visiting") throw new Error(`workspace dependency cycle: ${[...path, p.name].join(" -> ")}`);
		state.set(p.name, "visiting");
		for (const dep of Object.keys(p.json.dependencies ?? {})) {
			const q = byName.get(dep);
			if (q) visit(q, [...path, p.name]);
		}
		state.set(p.name, "done");
		ordered.push(p);
	};
	for (const p of all) visit(p, []);
	return ordered;
}
