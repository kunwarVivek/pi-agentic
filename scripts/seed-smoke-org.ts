/**
 * Seed a tiny org (ceo -> eng) into a fresh control.db for the S6 smoke test.
 * eng holds tool:bash and rw on its own workspace only.
 *   node scripts/seed-smoke-org.ts <control.db> <workspace-root>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlStore } from "pi-agentic-control-plane";
import { parseManifest } from "pi-agentic-core";

const [db, root] = process.argv.slice(2);
if (!db || !root) {
	process.stderr.write("usage: seed-smoke-org.ts <control.db> <workspace-root>\n");
	process.exit(2);
}
const budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };
const store = new ControlStore(db, {});
try {
	const raw = [
		{ id: "ceo", path: "ceo", parent: null, owner: "ceo@co", grants: ["tool:read", "delegate:*", "path:rw:/srv/org/ceo/**"], budget },
		{ id: "eng", path: "eng", parent: "ceo", owner: "eng@co", grants: ["tool:read", "tool:bash", "path:rw:/srv/org/eng/**"], budget },
		{ id: "ops", path: "ops", parent: "ceo", owner: "ops@co", grants: ["tool:read", "path:rw:/srv/org/ops/**"], budget },
	];
	for (const m of raw) {
		const withTrust = { ...m, trust: [join(root, m.path)] };
		store.addUnit(parseManifest(withTrust));
		// Authored source manifest: deploy render validates it and copies it to the
		// root-owned <ORG_MANIFEST_DIR>/<id>/unit.json (ORG_UNIT_MANIFEST points there,
		// never into the unit-writable workspace). `trust` lists the dirs whose .pi/.agents may load.
		mkdirSync(join(root, m.path), { recursive: true });
		writeFileSync(join(root, m.path, "unit.json"), `${JSON.stringify(withTrust, null, 2)}\n`);
	}
	process.stdout.write("seeded ceo + eng + ops\n");
} finally {
	store.close();
}
