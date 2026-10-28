/**
 * `org units sync` (agentic-pi-3sr.5): manifest discovery/validation, live sync over the admin
 * socket, and `--db` offline mode.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseManifest } from "pi-agentic-core";
import { ControlServer, ControlStore, PeerRegistry } from "pi-agentic-control-plane";
import { collectManifests, findManifestFiles, runUnits } from "../src/units.ts";
import { runCli } from "../src/main.ts";

const BUDGET = { tokens: 1000, costUsd: 1, wallClockSec: 60 };
function put(root: string, path: string, over: Record<string, unknown> = {}): void {
	const id = path.split("/").pop()!;
	const parent = path.includes("/") ? path.split("/").at(-2)! : null;
	mkdirSync(join(root, path), { recursive: true });
	writeFileSync(join(root, path, "unit.json"), JSON.stringify({ id, path, parent, owner: `${id}@co`, grants: ["tool:read"], budget: BUDGET, ...over }));
}

function org(fn: (root: string, dir: string) => void | Promise<void>): () => Promise<void> {
	return async () => {
		const dir = mkdtempSync(join(tmpdir(), "agentic-pi-units-"));
		const root = join(dir, "org");
		mkdirSync(root);
		try {
			await fn(root, dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

test("findManifestFiles walks nested unit.json, skipping node_modules and .git", org((root) => {
	put(root, "ceo");
	put(root, "ceo/sales");
	mkdirSync(join(root, "node_modules", "x"), { recursive: true });
	writeFileSync(join(root, "node_modules", "x", "unit.json"), "{}");
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "unit.json"), "{}");
	assert.deepEqual(findManifestFiles(root), ["ceo/sales/unit.json", "ceo/unit.json"]);
}));

test("collectManifests reports bad JSON, invalid manifests and path/dir mismatches", org((root) => {
	put(root, "good");
	mkdirSync(join(root, "broken"));
	writeFileSync(join(root, "broken", "unit.json"), "{nope");
	put(root, "inv", { owner: "" });
	put(root, "misplaced", { path: "elsewhere" });
	const { manifests, problems } = collectManifests(root);
	assert.equal(manifests.length, 1);
	assert.equal(problems.length, 3);
	assert.ok(problems.some((p) => p.startsWith("broken/unit.json")));
	assert.ok(problems.some((p) => /owner/.test(p)));
	assert.ok(problems.some((p) => /must equal its directory/.test(p)));
}));

test("runUnits sync refuses to touch anything when any manifest is invalid", org(async (root) => {
	put(root, "good");
	put(root, "inv", { owner: "" });
	let opened = false;
	const r = await runUnits(["sync", root], () => {
		opened = true;
		throw new Error("must not open");
	});
	assert.equal(r.exitCode, 1);
	assert.equal(opened, false);
	assert.ok(r.lines.some((l) => l.includes("nothing synced")));
}));

test("runUnits usage errors", async () => {
	assert.equal((await runUnits([], () => Promise.reject(new Error("x")))).exitCode, 2);
	assert.equal((await runUnits(["sync"], () => Promise.reject(new Error("x")))).exitCode, 2);
	assert.equal((await runUnits(["sync", "a", "b"], () => Promise.reject(new Error("x")))).exitCode, 2);
	assert.equal((await runUnits(["sync", "a", "--db"], () => Promise.reject(new Error("x")))).exitCode, 2);
});

test("org units sync --db (offline): adds, updates, reports removed, audits", org(async (root, dir) => {
	const db = join(dir, "control.db");
	new ControlStore(db, {}).close();
	put(root, "ceo");
	put(root, "ceo/sales");
	const lines: string[] = [];
	assert.equal(await runCli(["units", "sync", root, "--db", db], {}, (l) => lines.push(l)), 0);
	assert.ok(lines.some((l) => l.startsWith("added") && l.includes("sales")));

	put(root, "ceo", { budget: { tokens: 5, costUsd: 1, wallClockSec: 1 } });
	rmSync(join(root, "ceo", "sales"), { recursive: true });
	lines.length = 0;
	assert.equal(await runCli(["units", "sync", root, `--db=${db}`], {}, (l) => lines.push(l)), 0);
	assert.ok(lines.some((l) => l.startsWith("updated") && l.includes("budget")));
	assert.ok(lines.some((l) => l.startsWith("warning") && l.includes("sales")));

	const store = new ControlStore(db, {});
	try {
		assert.equal(store.getUnit("ceo")?.budget.tokens, 5);
		assert.ok(store.getUnit("sales"), "never deleted");
		const upd = store.auditEntries().find((e) => e.action === "unit.update");
		assert.equal(upd?.actor, "unit:offline-admin");
		assert.equal(store.verifyAudit().ok, true);
	} finally {
		store.close();
	}
}));

test("org units sync --db bootstraps a not-yet-existing control.db", org(async (root, dir) => {
	put(root, "ceo");
	const db = join(dir, "fresh.db");
	assert.equal(await runCli(["units", "sync", root, "--db", db], {}, () => {}), 0);
	const store = new ControlStore(db, {});
	try {
		assert.ok(store.getUnit("ceo"));
	} finally {
		store.close();
	}
}));

test("org units sync (live) goes through the admin socket and reports refused units with exit 1", org(async (root, dir) => {
	const store = new ControlStore(join(dir, "control.db"), {});
	store.addUnit(parseManifest({ id: "ceo", path: "ceo", parent: null, owner: "ceo@co", grants: ["tool:read"], budget: BUDGET }));
	const reg = new PeerRegistry();
	const tokenFile = join(dir, "admin.token");
	writeFileSync(tokenFile, reg.issueAdminToken(), { mode: 0o600 });
	const server = new ControlServer({ store, auth: reg });
	const socketPath = join(dir, "c.sock");
	await server.listen(socketPath);
	const env = { ORG_CONTROL_SOCKET: socketPath, ORG_ADMIN_TOKEN_FILE: tokenFile };
	try {
		put(root, "ceo");
		put(root, "ceo/sales");
		const lines: string[] = [];
		assert.equal(await runCli(["units", "sync", root], env, (l) => lines.push(l)), 0);
		assert.equal(store.getUnit("sales")?.parent, "ceo");

		// a parent change that would create a cycle is refused (exit 1) and not applied
		put(root, "ceo", { parent: "sales" });
		lines.length = 0;
		assert.equal(await runCli(["units", "sync", root], env, (l) => lines.push(l)), 1);
		assert.ok(lines.some((l) => l.startsWith("REFUSED") && l.includes("cycle")));
		assert.equal(store.getUnit("ceo")?.parent, null);
	} finally {
		await server.close();
		store.close();
	}
}));
