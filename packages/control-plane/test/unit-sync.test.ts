/**
 * `sync_units` / syncUnits / updateUnit (agentic-pi-3sr.5): additive, audited reconciliation of
 * units with authored manifests, admin-only over RPC, and the daemon's env config.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseManifest, type Budget, type Manifest } from "pi-agentic-core";
import { AdminClient } from "../src/admin-client.ts";
import { PeerRegistry } from "../src/auth.ts";
import { configFromEnv } from "../src/control-plane.ts";
import { ControlServer } from "../src/server.ts";
import { ControlStore } from "../src/store-control.ts";
import { syncUnits } from "../src/unit-sync.ts";

const BIG: Budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };
const raw = (id: string, parent: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	id,
	path: id,
	parent,
	owner: `${id}@co`,
	grants: ["tool:read"],
	budget: BIG,
	...extra,
});
const man = (id: string, parent: string | null, extra: Record<string, unknown> = {}): Manifest => parseManifest(raw(id, parent, extra));

function withStore(fn: (store: ControlStore, dir: string) => void | Promise<void>): () => Promise<void> {
	return async () => {
		const dir = mkdtempSync(join(tmpdir(), "agentic-pi-sync-"));
		const store = new ControlStore(join(dir, "control.db"), {});
		try {
			await fn(store, dir);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

const actions = (store: ControlStore): string[] => store.auditEntries().map((e) => e.action);

test("syncUnits adds new units parents-first regardless of manifest order", withStore((store) => {
	const r = syncUnits(store, [raw("sales", "ceo"), raw("emea", "sales"), raw("ceo", null)]);
	assert.deepEqual(r.added.sort(), ["ceo", "emea", "sales"]);
	assert.deepEqual(r.refused, []);
	assert.equal(store.getUnit("emea")?.parent, "sales");
	assert.equal(store.verifyAudit().ok, true);
}));

test("syncUnits updates changed fields with an audited unit.update and leaves status/usage alone", withStore((store) => {
	store.addUnit(man("ceo", null));
	store.addUnit(man("sales", "ceo"));
	store.setUnitStatus("sales", "suspended");
	const r = syncUnits(store, [
		raw("ceo", null),
		raw("sales", "ceo", { grants: ["tool:read", "tool:write"], budget: { tokens: 5, costUsd: 1, wallClockSec: 9 }, owner: "vp@co", minEval: 0.5, expiresAt: "2030-01-01T00:00:00.000Z", limits: { maxDepth: 2, maxChildren: 3, maxAttempts: 1 } }),
	]);
	assert.deepEqual(r.unchanged, ["ceo"]);
	assert.equal(r.updated.length, 1);
	assert.deepEqual(r.updated[0]!.changed.sort(), ["budget", "expiresAt", "grants", "limits", "minEval", "owner"]);
	const u = store.getUnit("sales")!;
	assert.equal(u.owner, "vp@co");
	assert.equal(u.minEval, 0.5);
	assert.equal(u.status, "suspended");
	assert.deepEqual(u.budget, { tokens: 5, costUsd: 1, wallClockSec: 9 });
	const entry = store.auditEntries().filter((e) => e.action === "unit.update");
	assert.equal(entry.length, 1);
	assert.equal(entry[0]!.actor, "unit:admin");
	assert.equal(entry[0]!.subject, "sales");
	assert.equal(store.verifyAudit().ok, true);
}));

test("syncUnits is idempotent: an identical re-sync writes no audit entries", withStore((store) => {
	syncUnits(store, [raw("ceo", null), raw("sales", "ceo")]);
	const before = store.auditEntries().length;
	const r = syncUnits(store, [raw("sales", "ceo"), raw("ceo", null)]);
	assert.deepEqual(r.unchanged.sort(), ["ceo", "sales"]);
	assert.equal(store.auditEntries().length, before);
}));

test("syncUnits never deletes: units without manifests are reported as removed", withStore((store) => {
	store.addUnit(man("ceo", null));
	store.addUnit(man("old", "ceo"));
	const r = syncUnits(store, [raw("ceo", null)]);
	assert.deepEqual(r.removed, ["old"]);
	assert.ok(store.getUnit("old"));
	assert.ok(!actions(store).includes("unit.remove"));
}));

test("syncUnits refuses a parent change that creates a cycle and leaves the unit untouched", withStore((store) => {
	store.addUnit(man("a", null));
	store.addUnit(man("b", "a"));
	store.addUnit(man("c", "b"));
	const r = syncUnits(store, [raw("a", "c"), raw("b", "a"), raw("c", "b")]);
	assert.equal(r.refused.length, 1);
	assert.equal(r.refused[0]!.id, "a");
	assert.match(r.refused[0]!.reason, /cycle/);
	assert.equal(store.getUnit("a")?.parent, null);
	assert.deepEqual(r.removed, []);
	// self-parent too
	assert.match(syncUnits(store, [raw("a", "a")]).refused[0]!.reason, /cycle/);
}));

test("syncUnits refuses path changes, unknown parents, duplicates and invalid manifests", withStore((store) => {
	store.addUnit(man("ceo", null));
	store.addUnit(man("sales", "ceo"));
	const r = syncUnits(store, [
		raw("ceo", null),
		raw("sales", "ceo", { path: "moved/sales" }),
		raw("ghost", "nobody"),
		raw("dup", null),
		raw("dup", null, { owner: "x@co" }),
		{ id: "Bad ID" },
	]);
	const by = new Map(r.refused.map((x) => [x.id, x.reason]));
	assert.match(by.get("sales")!, /path change/);
	assert.match(by.get("ghost")!, /not a known unit/);
	assert.match(by.get("dup")!, /duplicate/);
	assert.ok(by.has("Bad ID") || by.has("#5"));
	assert.equal(store.getUnit("dup"), null);
	assert.equal(store.getUnit("sales")?.path, "sales");
	assert.deepEqual(r.removed, []);
}));

test("syncUnits refuses mutually-parented new units", withStore((store) => {
	const r = syncUnits(store, [raw("x", "y"), raw("y", "x")]);
	assert.equal(r.added.length, 0);
	assert.equal(r.refused.length, 2);
}));

test("sync_units over RPC: admin applies; a unit session is forbidden; afterUnitsAdded runs", withStore(async (store, dir) => {
	store.addUnit(man("ceo", null));
	const reg = new PeerRegistry();
	let hooked = 0;
	const server = new ControlServer({ store, auth: reg, afterUnitsAdded: () => Promise.resolve(void hooked++) });
	const socketPath = join(dir, "c.sock");
	await server.listen(socketPath);
	const admin = new AdminClient({ socketPath, token: reg.issueAdminToken() });
	try {
		const r = await admin.syncUnits([raw("ceo", null), raw("sales", "ceo")]);
		assert.deepEqual(r.added, ["sales"]);
		assert.equal(hooked, 1);
		const r2 = await admin.syncUnits([raw("ceo", null), raw("sales", "ceo")]);
		assert.deepEqual(r2.unchanged.sort(), ["ceo", "sales"]);
		assert.equal(hooked, 1);
		await assert.rejects(admin.syncUnits("nope" as never), /bad_request/);
	} finally {
		admin.close();
		await server.close();
	}
	const denied = await server.handleRequest({ id: 1, method: "sync_units", params: { manifests: [raw("evil", null)] } }, { unitId: "ceo", admin: false }, null);
	assert.equal(denied.ok, false);
	if (!denied.ok) assert.equal(denied.error.code, "forbidden");
	assert.equal(store.getUnit("evil"), null);
}));

// ---- daemon env config ----------------------------------------------------

const BASE = { ORG_CONTROL_DB: "/x/control.db", ORG_CONTROL_SOCKET: "/x/c.sock", ORG_UNIT_SOCKET_DIR: "/run/pi-control" };

test("configFromEnv passes ORG_WORKER_MODE and ORG_MANIFEST_DIR to the plane options", () => {
	assert.equal(configFromEnv(BASE).workerMode, "pi");
	const c = configFromEnv({ ...BASE, ORG_WORKER_MODE: "durable", ORG_MANIFEST_DIR: "/etc/m", ORG_WORKSPACE_ROOT: "/srv/o", ORG_UNITS_DIR: "/u" });
	assert.equal(c.workerMode, "durable");
	assert.equal(c.manifestDir, "/etc/m");
	assert.equal(c.workspaceRoot, "/srv/o");
	assert.equal(c.unitsRoot, "/u");
});

test("configFromEnv fails closed on an unknown worker mode or a judge request", () => {
	assert.throws(() => configFromEnv({ ...BASE, ORG_WORKER_MODE: "docker" }), /ORG_WORKER_MODE must be pi\|durable/);
	assert.throws(() => configFromEnv({ ...BASE, ORG_JUDGE: "llm" }), /no judge implementation ships/);
	assert.doesNotThrow(() => configFromEnv({ ...BASE, ORG_JUDGE: "none" }));
});
