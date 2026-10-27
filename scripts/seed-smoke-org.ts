/**
 * Seed a tiny org (ceo -> eng) into a fresh control.db for the S6 smoke test.
 * eng holds tool:bash and rw on its own workspace only.
 *   node scripts/seed-smoke-org.ts <control.db> <workspace-root>
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ControlStore } from "@agentic-pi/control-plane";
import { parseManifest } from "@agentic-pi/core";

const [db, root] = process.argv.slice(2);
if (!db || !root) {
	process.stderr.write("usage: seed-smoke-org.ts <control.db> <workspace-root>\n");
	process.exit(2);
}
const budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };
const store = new ControlStore(db, {});
try {
	store.addUnit(parseManifest({ id: "ceo", path: "ceo", parent: null, owner: "ceo@co", grants: ["tool:read", "delegate:*", "path:rw:/srv/org/ceo/**"], budget }));
	store.addUnit(parseManifest({ id: "eng", path: "eng", parent: "ceo", owner: "eng@co", grants: ["tool:read", "tool:bash", "path:rw:/srv/org/eng/**"], budget }));
	for (const p of ["ceo", "eng"]) mkdirSync(join(root, p), { recursive: true });
	process.stdout.write("seeded ceo + eng\n");
} finally {
	store.close();
}
