/**
 * Re-audit wave 2 regressions for the control plane: N1 (dispatch isolation + scheduler
 * rejection), N3 (live-worker tracking), N4 (overrun conservation), N5 (owner inbox RPC),
 * N9/N11 (stale completeTask, extend offer), N12 (private socket umask), N10 (secret forwarding).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { parseManifest, type Budget, type Contract, type Manifest } from "pi-agentic-core";
import { Dispatcher, type WorkerSpec } from "../src/dispatcher.ts";
import { Scheduler, type SchedulerTimer } from "../src/scheduler.ts";
import { ControlServer, listenPrivate } from "../src/server.ts";
import { PeerRegistry } from "../src/auth.ts";
import { AdminClient } from "../src/admin-client.ts";
import { WorkerTracker, buildWorkerEnv, readUnitSecrets } from "../src/spawners.ts";
import { ControlStore, type ControlStoreOptions } from "../src/store-control.ts";
import type { ChildProcess } from "node:child_process";

const TMP = join(process.cwd(), ".tmp");
const BIG: Budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };
const tok = (tokens: number): Budget => ({ tokens, costUsd: 0, wallClockSec: 0 });
const CONTRACT: Contract = { schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } };
const man = (id: string, parent: string | null, budget: Budget = BIG): Manifest =>
	parseManifest({ id, path: parent ? `${parent}/${id}` : id, parent, owner: `${id}@co`, grants: ["tool:read", "delegate:*"], budget });

function fixtures(ceoBudget: Budget = BIG, storeOpts: ControlStoreOptions = {}) {
	let n = 0;
	mkdirSync(TMP, { recursive: true });
	const dir = mkdtempSync(join(TMP, "w2-"));
	const store = new ControlStore(join(dir, "control.db"), { genId: (p) => `${p}_${String(++n).padStart(4, "0")}`, ...storeOpts });
	store.addUnit(man("ceo", null, ceoBudget));
	store.addUnit(man("vp", "ceo"));
	store.addUnit(man("sales", "vp"));
	return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function pendingTask(store: ControlStore, to = "vp", from = "ceo"): string {
	const d = store.delegate({ fromUnit: from, toUnit: to, goal: "g", contract: CONTRACT, budget: tok(100) });
	assert.ok(d.ok);
	return d.taskId;
}

// ---- N1 -------------------------------------------------------------------

test("N1: a throwing isUnitBusy for one task neither aborts the tick nor strands the others", async () => {
	const { store, dir, cleanup } = fixtures();
	try {
		const a = pendingTask(store, "vp");
		const b = pendingTask(store, "sales", "vp");
		const spawned: string[] = [];
		const d = new Dispatcher({
			store,
			socketPath: join(dir, "s"),
			spawner: (s) => void spawned.push(s.task.id),
			isUnitBusy: (u) => {
				if (u.id === "vp") throw new Error("systemctl exploded");
				return false;
			},
		});
		assert.deepEqual(await d.tick(), [b]);
		assert.equal(store.getTask(a)?.status, "pending", "left pending for the next sweep");
		assert.ok(store.auditEntries().some((e) => e.action === "dispatch.error" && e.subject === a));
	} finally {
		cleanup();
	}
});

test("N1: a spawner that throws does not leave the task running forever: it escalates (retry/cancel)", async () => {
	const { store, dir, cleanup } = fixtures();
	try {
		const a = pendingTask(store);
		const d = new Dispatcher({
			store,
			socketPath: join(dir, "s"),
			spawner: () => {
				throw new Error("no such unit user");
			},
		});
		assert.deepEqual(await d.tick(), []);
		assert.equal(store.getTask(a)?.status, "escalated");
		const open = store.listOpenApprovals();
		assert.equal(open.length, 1);
		assert.match(open[0]!.question, /worker spawn failed: no such unit user/);
		assert.deepEqual(open[0]!.options, ["retry", "cancel"]);
	} finally {
		cleanup();
	}
});

test("N1: a task that stops being pending during the awaits is skipped, not thrown on", async () => {
	const { store, dir, cleanup } = fixtures();
	try {
		const a = pendingTask(store);
		const spawned: string[] = [];
		const d = new Dispatcher({
			store,
			socketPath: join(dir, "s"),
			spawner: (s) => void spawned.push(s.task.id),
			prepareUnit: () => {
				store.startTask(a); // somebody else started it while we awaited
			},
		});
		assert.deepEqual(await d.tick(), []);
		assert.deepEqual(spawned, []);
	} finally {
		cleanup();
	}
});

test("N1/N-sched: a failing sweep never escapes the timer as an unhandled rejection; the loop keeps going", async () => {
	const { store, cleanup } = fixtures();
	try {
		let tickFn: (() => unknown) | null = null;
		const timer: SchedulerTimer = {
			setInterval: (fn) => {
				tickFn = fn;
				return 1;
			},
			clearInterval: () => {
				tickFn = null;
			},
		};
		let calls = 0;
		const dispatcher = {
			tick: async () => {
				if (++calls === 1) throw new Error("boom");
				return [] as string[];
			},
		} as unknown as Dispatcher;
		const errors: unknown[] = [];
		const s = new Scheduler({ store, dispatcher, timer, onError: (e) => errors.push(e) });
		s.start();
		await (tickFn as unknown as () => Promise<void>)();
		assert.equal(errors.length, 1);
		assert.match((errors[0] as Error).message, /boom/);
		await (tickFn as unknown as () => Promise<void>)();
		assert.equal(calls, 2, "next interval still sweeps");
		s.stop();
		assert.equal(tickFn, null, "stop clears the injected timer");
	} finally {
		cleanup();
	}
});

// ---- N3 -------------------------------------------------------------------

class FakeChild extends EventEmitter {
	exitCode: number | null = null;
	signalCode: string | null = null;
	exit(): void {
		this.exitCode = 0;
		this.emit("exit", 0, null);
	}
}

test("N3: a rejected+requeued task is not started again while its worker is still alive", async () => {
	const { store, dir, cleanup } = fixtures();
	try {
		const a = pendingTask(store);
		const tracker = new WorkerTracker();
		const kids: FakeChild[] = [];
		const d = new Dispatcher({
			store,
			socketPath: join(dir, "s"),
			spawner: (s) => {
				const k = new FakeChild();
				kids.push(k);
				tracker.track(s.unit.id, k as unknown as ChildProcess);
			},
			isUnitBusy: (u) => tracker.isBusy(u.id),
		});
		assert.deepEqual(await d.tick(), [a]);
		const res = await store.completeTask(a, {}); // schema fails -> rejected -> requeued as pending
		assert.equal(res.status, "rejected");
		assert.equal(store.getTask(a)?.status, "pending");
		assert.deepEqual(await d.tick(), [], "worker alive: no second worker");
		assert.equal(kids.length, 1);
		kids[0]!.exit();
		assert.deepEqual(await d.tick(), [a], "worker gone: the retry runs");
		assert.equal(kids.length, 2);
	} finally {
		cleanup();
	}
});

// ---- N4 -------------------------------------------------------------------

test("N4: an overrun survives completion: parent.used gets the FULL usage, reservation is released", async () => {
	const { store, cleanup } = fixtures();
	try {
		const a = pendingTask(store); // budget 100 tokens
		store.startTask(a);
		store.meter(a, { tokens: 150, costUsd: 0.5, wallClockSec: 3 });
		// Escalated by the overrun; the owner approves a plain retry then the worker completes.
		const appr = store.listOpenApprovals()[0]!;
		store.resolveApproval(appr.id, "approved", "ceo@co", "extend");
		store.startTask(a);
		const res = await store.completeTask(a, { ok: true });
		assert.equal(res.status, "done");
		const ceo = store.getUnit("ceo")!;
		assert.equal(ceo.used.tokens, 150, "overrun tokens are charged in full, not clamped to the budget");
		assert.equal(ceo.used.costUsd, 0.5, "other dimensions are not over-charged to their reservation");
		assert.equal(ceo.used.wallClockSec, 3);
		assert.deepEqual(ceo.reserved, { tokens: 0, costUsd: 0, wallClockSec: 0 });
	} finally {
		cleanup();
	}
});

// ---- N5 -------------------------------------------------------------------

test("N5: owner inbox over RPC: admin sees all, an owner's unit session sees only its owner's; ack is scoped", async () => {
	const { store, dir, cleanup } = fixtures();
	const reg = new PeerRegistry();
	const server = new ControlServer({ store, auth: reg });
	const sock = join(dir, "c.sock");
	await server.listen(sock);
	const admin = new AdminClient({ socketPath: sock, token: reg.issueAdminToken() });
	try {
		const a = pendingTask(store, "vp");
		store.startTask(a);
		await store.completeTask(a, { ok: true }); // task.done -> ceo (owner ceo@co)
		const t2 = pendingTask(store, "sales", "vp");
		store.startTask(t2);
		await store.completeTask(t2, { ok: true }); // task.done -> vp (owner vp@co)
		const all = await admin.listNotifications();
		assert.deepEqual(all.map((n) => n.owner).sort(), ["ceo@co", "vp@co"]);
		// An owner session (a unit authenticated by token) sees only its owner's inbox.
		const ceoNotes = await server.handleRequest({ id: 1, method: "list_notifications", params: {} }, { unitId: "ceo", admin: false }, null);
		assert.ok(ceoNotes.ok);
		assert.deepEqual((ceoNotes.result as Array<{ owner: string }>).map((n) => n.owner), ["ceo@co"]);
		const foreign = await server.handleRequest({ id: 2, method: "ack_owner_notification", params: { id: all.find((n) => n.owner === "vp@co")!.id } }, { unitId: "ceo", admin: false }, null);
		assert.equal(foreign.ok, false, "an owner cannot ack another owner's notice");
		await admin.ackNotification(all[0]!.id);
		assert.equal((await admin.listNotifications()).length, 1);
		await assert.rejects(() => admin.ackNotification(all[0]!.id), /no unacked notification/);
	} finally {
		admin.close();
		await server.close();
		cleanup();
	}
});

// ---- N9 / N11 -------------------------------------------------------------

test("N9: completeTask re-reads the task after the judge await: a task escalated meanwhile is not completed", async () => {
	const { store, cleanup } = fixtures(BIG, { judge: async () => ({ pass: true, reason: "ok" }) });
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "vp", goal: "g", contract: { schema: { type: "object" }, judge: true }, budget: tok(100) });
		assert.ok(d.ok);
		store.startTask(d.taskId);
		const res = await store.completeTask(d.taskId, {}, async () => {
			store.escalate(d.taskId, "stop", ["cancel"]); // concurrent escalation while the judge runs
			return { pass: true, reason: "ok" };
		});
		assert.equal(res.ok, false);
		assert.equal(store.getTask(d.taskId)?.status, "escalated", "not flipped to done");
		assert.deepEqual(store.getUnit("ceo")?.reserved, tok(100), "reservation not released by a stale completion");
	} finally {
		cleanup();
	}
});

test("N11: an ancestor-ceiling breach offers only 'cancel' (extend could never succeed)", () => {
	const { store, cleanup } = fixtures(tok(120));
	try {
		const a = store.delegate({ fromUnit: "ceo", toUnit: "vp", goal: "a", contract: CONTRACT, budget: tok(100) });
		assert.ok(a.ok);
		store.startTask(a.taskId);
		const b = store.delegate({ fromUnit: "vp", toUnit: "sales", goal: "b", contract: CONTRACT, budget: tok(200), parentTask: a.taskId });
		assert.ok(b.ok);
		store.startTask(b.taskId);
		const over = store.meter(b.taskId, tok(150)); // b itself is within 200, ceo's ceiling (120) is breached
		assert.deepEqual(over.overBudget, ["tokens"]);
		assert.deepEqual(over.escalation?.options, ["cancel"]);
		// An own-limit overrun still offers extend.
		const own = store.meter(a.taskId, tok(1000));
		assert.ok(own.overBudget.includes("tokens"));
	} finally {
		cleanup();
	}
});

// ---- N12 ------------------------------------------------------------------

test("N12: a socket is private (0600) from creation even under a permissive umask", async () => {
	mkdirSync(TMP, { recursive: true });
	const dir = mkdtempSync(join(TMP, "w2u-"));
	const prev = process.umask(0);
	const server = createServer();
	try {
		const path = join(dir, "s.sock");
		let modeAtListen = 0;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			listenPrivate(server, path, () => {
				modeAtListen = statSync(path).mode & 0o777;
				resolve();
			});
		});
		assert.equal(modeAtListen, 0o600);
		assert.equal(process.umask(), 0, "process umask restored");
	} finally {
		process.umask(prev);
		await new Promise<void>((r) => server.close(() => r()));
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---- N10 (secret forwarding) ---------------------------------------------

test("N10: declared secrets from the root-owned secrets.env are forwarded; undeclared and reserved names are not", () => {
	mkdirSync(TMP, { recursive: true });
	const dir = mkdtempSync(join(TMP, "w2s-"));
	try {
		const manifest = join(dir, "unit.json");
		writeFileSync(manifest, JSON.stringify({ id: "eng", secrets: ["OPENAI_API_KEY", "PATH", "ORG_UNIT_ID", "bad name"] }));
		writeFileSync(join(dir, "secrets.env"), "OPENAI_API_KEY=sk-test-123\nUNDECLARED=x\nPATH=/evil\nORG_UNIT_ID=evil\n");
		const spec = { mode: "pi", env: { ORG_UNIT_MANIFEST: manifest, ORG_UNIT_ID: "eng" }, cwd: dir, unit: { id: "eng" }, task: { id: "t" } } as unknown as WorkerSpec;
		const secrets = readUnitSecrets(spec);
		assert.deepEqual(secrets, { OPENAI_API_KEY: "sk-test-123" });
		const env = buildWorkerEnv(spec, { secrets });
		assert.equal(env.OPENAI_API_KEY, "sk-test-123");
		assert.equal(env.ORG_UNIT_ID, "eng");
		assert.notEqual(env.PATH, "/evil");
		// No file / no manifest: nothing forwarded.
		assert.deepEqual(readUnitSecrets({ ...spec, env: { ORG_UNIT_MANIFEST: join(dir, "missing.json") } } as unknown as WorkerSpec), {});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
