/**
 * Reconcile the control store's units with authored `unit.json` manifests (`org units sync`).
 *
 * Additive and audited: new manifests become units (`unit.add`), existing units get their
 * owner/parent/grants/budget/limits/expiresAt/minEval updated (`unit.update`). A unit that
 * is in the store but has no manifest is NEVER deleted or suspended; it is only reported.
 * A manifest that cannot be applied (invalid, duplicate id, path change, unknown parent,
 * parent cycle) is reported per unit and leaves that unit untouched.
 */

import { type Manifest, ManifestError, parseManifest } from "pi-agentic-core";

import type { ControlStore } from "./store-control.ts";

export interface SyncUpdated {
	id: string;
	changed: string[];
}

export interface SyncRefused {
	id: string;
	reason: string;
}

export interface SyncReport {
	added: string[];
	updated: SyncUpdated[];
	unchanged: string[];
	/** In the store but absent from the manifests. Left untouched; remove/suspend them deliberately. */
	removed: string[];
	/** Manifests that were refused (store untouched for these units). */
	refused: SyncRefused[];
}

/** Parse each raw manifest; a ManifestError or duplicate id is reported rather than thrown. */
export function parseManifests(raw: readonly unknown[]): { manifests: Manifest[]; refused: SyncRefused[] } {
	const manifests: Manifest[] = [];
	const refused: SyncRefused[] = [];
	const seen = new Set<string>();
	raw.forEach((r, i) => {
		let m: Manifest;
		try {
			m = parseManifest(r);
		} catch (e) {
			const rawId = typeof r === "object" && r !== null && "id" in r ? r.id : undefined;
			const id = typeof rawId === "string" ? rawId : `#${i}`;
			refused.push({ id, reason: e instanceof ManifestError ? e.problems.join("; ") : (e as Error).message });
			return;
		}
		if (seen.has(m.id)) refused.push({ id: m.id, reason: "duplicate manifest id" });
		else {
			seen.add(m.id);
			manifests.push(m);
		}
	});
	// A duplicated id is ambiguous: drop the first occurrence too.
	const dup = new Set(refused.filter((r) => r.reason === "duplicate manifest id").map((r) => r.id));
	return { manifests: manifests.filter((m) => !dup.has(m.id)), refused };
}

/** Apply manifests to the store. `actor` is the audit actor of unit.update entries. */
export function syncUnits(store: ControlStore, raw: readonly unknown[], actor = "admin"): SyncReport {
	const { manifests, refused } = parseManifests(raw);
	const report: SyncReport = { added: [], updated: [], unchanged: [], removed: [], refused };
	const authored = new Set(manifests.map((m) => m.id));
	const existing = new Set(store.listUnits().map((u) => u.id));

	for (const m of manifests) {
		if (!existing.has(m.id)) continue;
		try {
			const changed = store.updateUnit(m, actor);
			if (changed.length > 0) report.updated.push({ id: m.id, changed });
			else report.unchanged.push(m.id);
		} catch (e) {
			refused.push({ id: m.id, reason: (e as Error).message });
		}
	}

	// New units: parents first. Loop until no progress; whatever remains has a missing/cyclic parent.
	let pending = manifests.filter((m) => !existing.has(m.id));
	for (let progress = true; progress && pending.length > 0; ) {
		progress = false;
		const next: Manifest[] = [];
		for (const m of pending) {
			if (m.parent !== null && !store.getUnit(m.parent)) {
				next.push(m);
				continue;
			}
			try {
				store.addUnit(m);
				report.added.push(m.id);
				progress = true;
			} catch (e) {
				refused.push({ id: m.id, reason: (e as Error).message });
			}
		}
		pending = next;
	}
	for (const m of pending) refused.push({ id: m.id, reason: `parent ${m.parent} is not a known unit (missing, refused, or part of a cycle)` });

	const refusedIds = new Set(refused.map((r) => r.id));
	report.removed = [...existing].filter((id) => !authored.has(id) && !refusedIds.has(id)).sort();
	return report;
}
