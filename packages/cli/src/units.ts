/**
 * `org units sync <org-root> [--db <control.db>]` — register/update units from the org repo's
 * `unit.json` manifests (additive and audited; nothing is ever deleted).
 *
 * Default: talk to the RUNNING control plane over the admin socket (`sync_units`). `--db` opens
 * control.db directly instead, for use while the daemon is STOPPED (the daemon is the single
 * writer; never use `--db` against a live one).
 *
 * The command core is pure w.r.t. process: it takes a target (AdminClient, or an offline store)
 * and returns the lines to print plus an exit code.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { ManifestError, parseManifest } from "pi-agentic-core";
import type { SyncReport } from "pi-agentic-control-plane";

import type { CommandOutput } from "./approvals.ts";

/** What `units sync` needs from a control plane (AdminClient live, or an offline ControlStore). */
export interface UnitSyncTarget {
	syncUnits(manifests: readonly unknown[]): Promise<SyncReport>;
}

/** Opens the target for `--db <path>` (offline) or, when undefined, the live daemon. */
export type TargetOpener = (db: string | undefined) => Promise<{ target: UnitSyncTarget; close(): void }>;

const USAGE = [
	"usage: org units sync <org-root> [--db <control.db>]",
	"  sync <org-root>   register new units and update existing ones from every unit.json under <org-root>",
	"                    (a unit's unit.json must sit in <org-root>/<its path>/). Never deletes: units with no",
	"                    manifest are only reported.",
	"  --db <control.db> offline mode: write control.db directly. ONLY while pi-control is stopped.",
].join("\n");

const SKIP_DIRS: Record<string, true> = { node_modules: true, ".git": true };

/** Every `unit.json` under `root` (symlinks are not followed), as paths relative to root, sorted. */
export function findManifestFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) {
				if (!Object.hasOwn(SKIP_DIRS, e.name)) walk(join(dir, e.name));
			} else if (e.isFile() && e.name === "unit.json") out.push(relative(root, join(dir, e.name)));
		}
	};
	walk(root);
	return out.sort();
}

/**
 * Read + validate every manifest. Any problem (bad JSON, parseManifest failure, manifest path not
 * matching its directory) is returned and nothing should be synced: a partial view would make the
 * "removed" report wrong.
 */
export function collectManifests(root: string): { manifests: unknown[]; problems: string[] } {
	const manifests: unknown[] = [];
	const problems: string[] = [];
	for (const rel of findManifestFiles(root)) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(root, rel), "utf8"));
		} catch (e) {
			problems.push(`${rel}: ${(e as Error).message}`);
			continue;
		}
		try {
			const m = parseManifest(raw);
			const dir = rel.split(sep).slice(0, -1).join("/");
			if (m.path !== dir) problems.push(`${rel}: manifest path '${m.path}' must equal its directory '${dir}' (workspace = <org-root>/<path>)`);
			else manifests.push(raw);
		} catch (e) {
			problems.push(`${rel}: ${e instanceof ManifestError ? e.problems.join("; ") : (e as Error).message}`);
		}
	}
	return { manifests, problems };
}

export function formatSyncReport(r: SyncReport): string[] {
	const lines: string[] = [];
	for (const id of r.added) lines.push(`added      ${id}`);
	for (const u of r.updated) lines.push(`updated    ${u.id} (${u.changed.join(", ")})`);
	for (const x of r.refused) lines.push(`REFUSED    ${x.id}: ${x.reason}`);
	if (r.removed.length > 0) lines.push(`warning: no manifest for ${r.removed.join(", ")}; left in place (units are never deleted by sync)`);
	lines.push(`${r.added.length} added, ${r.updated.length} updated, ${r.unchanged.length} unchanged, ${r.removed.length} without manifest, ${r.refused.length} refused`);
	return lines;
}

export async function runUnits(argv: readonly string[], open: TargetOpener): Promise<CommandOutput> {
	const [sub, ...rest] = argv;
	if (sub !== "sync") return { lines: [sub ? `error: unknown subcommand '${sub}'` : "error: missing subcommand", USAGE], exitCode: 2 };
	let db: string | undefined;
	let root: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (a === "--db" || a.startsWith("--db=")) {
			db = a === "--db" ? rest[++i] : a.slice("--db=".length);
			if (!db) return { lines: ["error: --db needs a path", USAGE], exitCode: 2 };
		} else if (a.startsWith("-") || root !== undefined) return { lines: [`error: unexpected argument '${a}'`, USAGE], exitCode: 2 };
		else root = a;
	}
	if (!root) return { lines: ["error: sync needs <org-root>", USAGE], exitCode: 2 };

	const { manifests, problems } = collectManifests(root);
	if (problems.length > 0) return { lines: [...problems.map((p) => `invalid     ${p}`), "nothing synced: fix the manifests above"], exitCode: 1 };
	if (manifests.length === 0) return { lines: [`error: no unit.json found under ${root}`], exitCode: 1 };

	const { target, close } = await open(db);
	try {
		const report = await target.syncUnits(manifests);
		return { lines: formatSyncReport(report), exitCode: report.refused.length > 0 ? 1 : 0 };
	} finally {
		close();
	}
}
