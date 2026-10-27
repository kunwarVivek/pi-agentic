/**
 * S4 tests: control-plane RPC (protocol framing, auth, server handling),
 * the socket-backed client end-to-end over a real Unix socket, and the
 * dispatcher's inbox tick with an injected spawner.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlStore } from "../src/store-control.ts";
import { parseManifest, type Budget, type Manifest } from "@agentic-pi/core";
import type { Contract } from "@agentic-pi/core";
import { LineDecoder, encodeLine, PROTOCOL_VERSION } from "../src/protocol.ts";
import { PeerRegistry, authenticate } from "../src/auth.ts";
import { ControlServer } from "../src/server.ts";
import { SocketControlClient } from "../src/socket-client.ts";
import { AdminClient } from "../src/admin-client.ts";
import { Dispatcher, type WorkerSpec } from "../src/dispatcher.ts";

const BIG: Budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };
const man = (id: string, path: string, parent: string | null, grants: string[], budget: Budget = BIG): Manifest =>
	parseManifest({ id, path, parent, owner: `${id}@co`, grants, budget });

const CONTRACT: Contract = {
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["summary"],
		properties: { summary: { type: "string", minLength: 1 } },
	},
};

const smallBudget: Budget = { tokens: 500, costUsd: 1, wallClockSec: 60 };

function fixtures() {
	let t = Date.parse("2026-01-01T00:00:00.000Z");
	let n = 0;
	const dir = mkdtempSync(join(tmpdir(), "agentic-pi-s4-"));
	const store = new ControlStore(join(dir, "control.db"), {
		clock: () => t,
		genId: (p) => `${p}_${String(++n).padStart(4, "0")}`,
	});
	store.addUnit(man("ceo", "ceo", null, ["tool:read", "delegate:*", "path:rw:/d/**"]));
	store.addUnit(man("sales", "sales", "ceo", ["tool:read", "path:rw:/d/sales/**"]));
	return {
		store,
		dir,
		socketPath: join(dir, "control.sock"),
		advance: (ms: number) => (t += ms),
		cleanup: () => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

// ---- protocol framing ----------------------------------------------------

test("LineDecoder splits multiple and partial JSON lines", () => {
	const d = new LineDecoder();
	assert.deepEqual(d.push('{"a":1}\n{"b":'), [{ a: 1 }]);
	assert.deepEqual(d.push('2}\n'), [{ b: 2 }]);
	assert.deepEqual(d.push("\n\n"), []); // blank lines ignored
});

test("LineDecoder rejects invalid JSON and oversized lines", () => {
	assert.throws(() => new LineDecoder().push("not json\n"), /not valid JSON/);
	assert.throws(() => new LineDecoder(8).push("123456789\n"), /exceeded maximum length/);
});

test("encodeLine round-trips through the decoder", () => {
	const d = new LineDecoder();
	const msg = { id: 7, method: "hello", params: { version: PROTOCOL_VERSION } };
	assert.deepEqual(d.push(encodeLine(msg as never)), [msg]);
});

// ---- auth ----------------------------------------------------------------

test("PeerRegistry maps uid and token; uid wins over token", () => {
	const reg = new PeerRegistry();
	reg.bindUid(1001, "sales");
	const token = reg.issueToken("sales");
	assert.equal(reg.issueToken("sales"), token, "token issuance is idempotent");
	assert.equal(reg.byUid(1001), "sales");
	assert.equal(reg.byToken(token), "sales");
	assert.equal(reg.byToken("deadbeef"), null);
	assert.deepEqual(authenticate(reg, { uid: 1001, token: "wrong" }), { kind: "unit", unitId: "sales" });
	assert.deepEqual(authenticate(reg, { token }), { kind: "unit", unitId: "sales" });
	assert.equal(authenticate(reg, {}), null);
});

test("PeerRegistry issues an admin token distinct from unit tokens", () => {
	const reg = new PeerRegistry();
	const unitToken = reg.issueToken("sales");
	const admin = reg.issueAdminToken();
	assert.notEqual(admin, unitToken);
	assert.equal(reg.isAdminToken(admin), true);
	assert.equal(reg.isAdminToken(unitToken), false);
	assert.equal(reg.byToken(admin), null, "admin token maps to no unit");
	assert.deepEqual(authenticate(reg, { token: admin }), { kind: "admin" });
});

// ---- server handleRequest (no socket) ------------------------------------

test("handleRequest: hello version mismatch is rejected", async () => {
	const { store, cleanup } = fixtures();
	try {
		const server = new ControlServer({ store, auth: new PeerRegistry() });
		const res = await server.handleRequest({ id: 1, method: "hello", params: { version: 999 } }, { unitId: "sales", admin: false }, null);
		assert.equal(res.ok, false);
		assert.equal(res.ok === false ? res.error.code : "", "version_mismatch");
	} finally {
		cleanup();
	}
});

test("handleRequest: a unit cannot complete a task it does not own", async () => {
	const { store, cleanup } = fixtures();
	try {
		const server = new ControlServer({ store, auth: new PeerRegistry() });
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		// "ceo" is not the assignee ("sales" is) → forbidden.
		const res = await server.handleRequest(
			{ id: 2, method: "complete_task", params: { taskId: d.taskId, artifact: { summary: "x" } } },
			{ unitId: "ceo", admin: false },
			d.taskId,
		);
		assert.equal(res.ok, false);
		assert.equal(res.ok === false ? res.error.code : "", "forbidden");
	} finally {
		cleanup();
	}
});

test("handleRequest: unit lists only its owner's approvals; admin sees all", async () => {
	const { store, cleanup } = fixtures();
	try {
		const server = new ControlServer({ store, auth: new PeerRegistry() });
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const appr = store.escalate(d.taskId, "ship?", ["yes", "no"]); // owner = sales@co
		// sales unit sees its own owner's approval.
		const asSales = await server.handleRequest({ id: 1, method: "list_approvals", params: {} }, { unitId: "sales", admin: false }, null);
		assert.ok(asSales.ok);
		assert.deepEqual((asSales.ok ? (asSales.result as Array<{ id: string }>) : []).map((a) => a.id), [appr.id]);
		// ceo unit does NOT own this approval → empty inbox.
		const asCeo = await server.handleRequest({ id: 2, method: "list_approvals", params: {} }, { unitId: "ceo", admin: false }, null);
		assert.ok(asCeo.ok);
		assert.equal((asCeo.ok ? (asCeo.result as unknown[]) : []).length, 0);
		// admin sees everything.
		const asAdmin = await server.handleRequest({ id: 3, method: "list_approvals", params: {} }, { unitId: "", admin: true }, null);
		assert.ok(asAdmin.ok);
		assert.equal((asAdmin.ok ? (asAdmin.result as unknown[]) : []).length, 1);
	} finally {
		cleanup();
	}
});

test("handleRequest: a unit cannot resolve an approval it does not own", async () => {
	const { store, cleanup } = fixtures();
	try {
		const server = new ControlServer({ store, auth: new PeerRegistry() });
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const appr = store.escalate(d.taskId, "ship?", ["yes", "no"]); // owner = sales@co
		// ceo unit tries to resolve sales' approval → forbidden.
		const denied = await server.handleRequest(
			{ id: 1, method: "resolve_approval", params: { id: appr.id, decision: "approved" } },
			{ unitId: "ceo", admin: false },
			null,
		);
		assert.equal(denied.ok, false);
		assert.equal(denied.ok === false ? denied.error.code : "", "forbidden");
		// admin can resolve it, and the task is re-opened as pending.
		const okRes = await server.handleRequest(
			{ id: 2, method: "resolve_approval", params: { id: appr.id, decision: "approved", choice: "yes" } },
			{ unitId: "", admin: true },
			null,
		);
		assert.ok(okRes.ok);
		assert.equal(store.getApproval(appr.id)?.decidedBy, "admin");
		assert.equal(store.getTask(d.taskId)?.status, "pending");
	} finally {
		cleanup();
	}
});

// ---- socket client end-to-end --------------------------------------------

test("SocketControlClient: hello handshake, snapshot, delegate round-trip", async () => {
	const { store, socketPath, cleanup } = fixtures();
	const reg = new PeerRegistry();
	const token = reg.issueToken("ceo");
	const server = new ControlServer({ store, auth: reg });
	await server.listen(socketPath);
	const client = new SocketControlClient({ unitId: "ceo", taskId: null, socketPath, token });
	try {
		await client.connectAndHello();
		const snap = client.snapshot();
		assert.equal(snap.unit?.id, "ceo");
		assert.deepEqual(client.remainingBudget(), BIG);

		const result = await client.delegate({ toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
		assert.ok(result.ok, "delegate should succeed");
		assert.equal(store.getTask(result.ok ? result.taskId : "")?.toUnit, "sales");

		// Reserving budget should show up on refresh.
		const refreshed = await client.refresh();
		assert.equal(refreshed.remainingBudget.tokens, BIG.tokens - smallBudget.tokens);
	} finally {
		client.close();
		await server.close();
		cleanup();
	}
});

test("SocketControlClient: unauthenticated when no credential maps", async () => {
	const { store, socketPath, cleanup } = fixtures();
	const server = new ControlServer({ store, auth: new PeerRegistry() });
	await server.listen(socketPath);
	const client = new SocketControlClient({ unitId: "ceo", taskId: null, socketPath, token: "bogus" });
	try {
		await assert.rejects(() => client.connectAndHello(), /unauthenticated/);
	} finally {
		client.close();
		await server.close();
		cleanup();
	}
});

test("AdminClient: list + resolve approvals over a real socket (ADR-0007)", async () => {
	const { store, socketPath, cleanup } = fixtures();
	const reg = new PeerRegistry();
	const adminToken = reg.issueAdminToken();
	const server = new ControlServer({ store, auth: reg });
	await server.listen(socketPath);
	const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
	assert.ok(d.ok);
	const appr = store.escalate(d.ok ? d.taskId : "", "ship?", ["yes", "no"]);
	const admin = new AdminClient({ socketPath, token: adminToken });
	try {
		const open = await admin.listApprovals();
		assert.deepEqual(open.map((a) => a.id), [appr.id]);
		const resolved = await admin.resolveApproval(appr.id, "denied");
		assert.equal(resolved.status, "denied");
		assert.equal(resolved.decidedBy, "admin");
		// denial cancels the task.
		assert.equal(store.getTask(d.ok ? d.taskId : "")?.status, "cancelled");
	} finally {
		admin.close();
		await server.close();
		cleanup();
	}
});

test("AdminClient: a bad admin token is rejected at hello", async () => {
	const { store, socketPath, cleanup } = fixtures();
	const server = new ControlServer({ store, auth: new PeerRegistry() });
	await server.listen(socketPath);
	const admin = new AdminClient({ socketPath, token: "nope" });
	try {
		await assert.rejects(() => admin.listApprovals(), /unauthenticated/);
	} finally {
		admin.close();
		await server.close();
		cleanup();
	}
});

// ---- dispatcher ----------------------------------------------------------

test("Dispatcher.tick starts pending tasks and wires ORG_* env", async () => {
	const { store, socketPath, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const reg = new PeerRegistry();
		const spawned: WorkerSpec[] = [];
		const dispatcher = new Dispatcher({
			store,
			socketPath,
			tokenOf: (id) => reg.issueToken(id),
			spawner: (spec) => {
				spawned.push(spec);
			},
		});
		const ids = await dispatcher.tick();
		assert.deepEqual(ids, [d.ok ? d.taskId : ""]);
		assert.equal(store.getTask(d.ok ? d.taskId : "")?.status, "running");
		assert.equal(spawned.length, 1);
		const spec = spawned[0]!;
		assert.equal(spec.env.ORG_UNIT_ID, "sales");
		assert.equal(spec.env.ORG_CONTROL_DB, store.dbPath);
		assert.equal(spec.env.ORG_TASK_ID, d.ok ? d.taskId : "");
		assert.equal(spec.env.ORG_CONTROL_SOCKET, socketPath);
		assert.ok(spec.env.ORG_UNIT_TOKEN && spec.env.ORG_UNIT_TOKEN.length > 0);
		assert.equal(spec.cwd, "/srv/org/sales");

		// A second tick finds nothing pending.
		assert.deepEqual(await dispatcher.tick(), []);
	} finally {
		cleanup();
	}
});

test("Dispatcher skips inactive units and records spawn errors", async () => {
	const { store, socketPath, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		store.setUnitStatus("sales", "suspended");
		const dispatcher = new Dispatcher({ store, socketPath, spawner: () => {} });
		assert.deepEqual(await dispatcher.tick(), [], "suspended unit is skipped");
		assert.equal(store.getTask(d.ok ? d.taskId : "")?.status, "pending");

		// Reactivate; spawner throws → task still marked running, error audited.
		store.setUnitStatus("sales", "active");
		const failing = new Dispatcher({
			store,
			socketPath,
			spawner: () => {
				throw new Error("boom");
			},
		});
		assert.deepEqual(await failing.tick(), []);
		assert.equal(store.getTask(d.ok ? d.taskId : "")?.status, "running");
		const audit = store.auditEntries().some((e) => e.action === "dispatch.error");
		assert.ok(audit, "spawn error is audited");
	} finally {
		cleanup();
	}
});
