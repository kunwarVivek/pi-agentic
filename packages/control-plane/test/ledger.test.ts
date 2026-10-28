import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStore, type ControlStoreOptions } from "../src/store-control.ts";
import { parseManifest, type Budget, type Contract, type Manifest } from "pi-agentic-core";

const TMP = join(process.cwd(), ".tmp");
const Z: Budget = { tokens: 0, costUsd: 0, wallClockSec: 0 };
const tok = (tokens: number): Budget => ({ tokens, costUsd: 0, wallClockSec: 0 });
const BIG: Budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };
const man = (id: string, parent: string | null, budget: Budget = BIG): Manifest =>
	parseManifest({ id, path: parent ? `${parent}/${id}` : id, parent, owner: `${id}@co`, grants: ["tool:read", "delegate:*"], budget });
const CONTRACT: Contract = { schema: { type: "object" } };
const JUDGED: Contract = { schema: { type: "object" }, judge: true };

function fixtures(opts: ControlStoreOptions = {}, ceoBudget: Budget = BIG) {
	let t = Date.parse("2026-01-01T00:00:00.000Z");
	let n = 0;
	const clock = () => t;
	const advance = (ms: number) => {
		t += ms;
	};
	mkdirSync(TMP, { recursive: true });
	const dir = mkdtempSync(join(TMP, "ledger-"));
	const dbPath = join(dir, "control.db");
	const store = new ControlStore(dbPath, { clock, genId: (p) => `${p}_${String(++n).padStart(4, "0")}`, ...opts });
	// ceo → vp → sales
	store.addUnit(man("ceo", null, ceoBudget));
	store.addUnit(man("vp", "ceo"));
	store.addUnit(man("sales", "vp"));
	return { store, dbPath, advance, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("last_active is touched by meter, completeTask and recordDecision (FR8)", async () => {
	const { store, advance, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "vp", goal: "g", contract: CONTRACT, budget: tok(500) });
		assert.ok(d.ok);
		assert.equal(store.getUnit("vp")?.lastActive, null);
		advance(1000);
		store.meter(d.taskId, tok(1));
		const afterMeter = store.getUnit("vp")?.lastActive;
		assert.equal(afterMeter, "2026-01-01T00:00:01.000Z");
		advance(1000);
		store.recordDecision("vp", d.taskId, { toolName: "read", paths: [] } as never, { allow: true } as never);
		const afterDecision = store.getUnit("vp")?.lastActive;
		assert.equal(afterDecision, "2026-01-01T00:00:02.000Z");
		advance(1000);
		await store.completeTask(d.taskId, {});
		assert.equal(store.getUnit("vp")?.lastActive, "2026-01-01T00:00:03.000Z");
	} finally {
		cleanup();
	}
});

test("meter enforces every ancestor's ceiling, not just the executing unit's (FR6)", () => {
	// ceo ceiling 120; task A (ceo→vp) reserves 100; task B (vp→sales) is allowed 200 by vp.
	const { store, cleanup } = fixtures({}, tok(120));
	try {
		const a = store.delegate({ fromUnit: "ceo", toUnit: "vp", goal: "a", contract: CONTRACT, budget: tok(100) });
		assert.ok(a.ok);
		store.startTask(a.taskId);
		const b = store.delegate({ fromUnit: "vp", toUnit: "sales", goal: "b", contract: CONTRACT, budget: tok(200), parentTask: a.taskId });
		assert.ok(b.ok, JSON.stringify(b));
		store.startTask(b.taskId);
		const within = store.meter(b.taskId, tok(90));
		assert.deepEqual(within.overBudget, []);
		// 90 + 60 = 150 tokens flowed through A (reserved 100) → ceo (ceiling 120) is breached.
		const over = store.meter(b.taskId, tok(60));
		assert.deepEqual(over.overBudget, ["tokens"]);
		assert.ok(over.escalation, "breach escalates the metered task");
		assert.equal(store.getTask(a.taskId)?.used.tokens, 150, "ancestor task is charged in flight");
	} finally {
		cleanup();
	}
});

test("3-level completion rolls usage up every level exactly once (FR6)", async () => {
	const { store, cleanup } = fixtures();
	try {
		const a = store.delegate({ fromUnit: "ceo", toUnit: "vp", goal: "a", contract: CONTRACT, budget: tok(1000) });
		assert.ok(a.ok);
		store.startTask(a.taskId);
		const b1 = store.delegate({ fromUnit: "vp", toUnit: "sales", goal: "b1", contract: CONTRACT, budget: tok(300), parentTask: a.taskId });
		const b2 = store.delegate({ fromUnit: "vp", toUnit: "sales", goal: "b2", contract: CONTRACT, budget: tok(300), parentTask: a.taskId });
		assert.ok(b1.ok && b2.ok);
		store.startTask(b1.taskId);
		store.startTask(b2.taskId);
		store.meter(a.taskId, tok(50)); // vp's own work
		store.meter(b1.taskId, tok(100));
		store.meter(b2.taskId, tok(200));
		await store.completeTask(b1.taskId, {});
		assert.equal(store.getUnit("vp")?.used.tokens, 50 + 100, "vp: own 50 + b1");
		assert.equal(store.getUnit("ceo")?.used.tokens, 0, "ceo not charged until A completes");
		await store.completeTask(b2.taskId, {});
		assert.equal(store.getUnit("vp")?.used.tokens, 50 + 100 + 200);
		assert.deepEqual(store.getUnit("vp")?.reserved, Z);
		await store.completeTask(a.taskId, {});
		// ceo sees vp's own 50 plus both sales tasks (300), each exactly once.
		assert.equal(store.getUnit("ceo")?.used.tokens, 350);
		assert.deepEqual(store.getUnit("ceo")?.reserved, Z);
		assert.equal(store.getUnit("sales")?.used.tokens, 300, "sales ceiling usage is its own metering only");
	} finally {
		cleanup();
	}
});

test("audit table rejects UPDATE and DELETE at the DB level (FR7)", () => {
	const { store, dbPath, cleanup } = fixtures();
	try {
		const raw = new DatabaseSync(dbPath);
		try {
			assert.throws(() => raw.exec("UPDATE audit SET actor='evil' WHERE seq=1"), /append-only/);
			assert.throws(() => raw.exec("DELETE FROM audit WHERE seq=1"), /append-only/);
		} finally {
			raw.close();
		}
		assert.deepEqual(store.verifyAudit().ok, true);
	} finally {
		cleanup();
	}
});

test("verifyAudit catches a row edited after the triggers are bypassed (FR7 tamper)", () => {
	const { store, dbPath, cleanup } = fixtures();
	try {
		assert.ok(store.verifyAudit().ok);
		const raw = new DatabaseSync(dbPath);
		try {
			raw.exec("DROP TRIGGER audit_no_update");
			raw.exec("UPDATE audit SET actor='unit:evil' WHERE seq=2");
		} finally {
			raw.close();
		}
		const v = store.verifyAudit();
		assert.equal(v.ok, false);
		assert.equal(v.ok === false ? v.badSeq : -1, 2);
	} finally {
		cleanup();
	}
});

test("delegate rejects judge:true contracts unless the store has a judge; completion uses it (G5)", async () => {
	const none = fixtures();
	try {
		const r = none.store.delegate({ fromUnit: "ceo", toUnit: "vp", goal: "g", contract: JUDGED, budget: tok(10) });
		assert.equal(r.ok, false);
		assert.equal(r.ok === false ? r.code : "", "judge_unavailable");
		assert.deepEqual(none.store.getUnit("ceo")?.reserved, Z, "nothing reserved by a rejected delegation");
	} finally {
		none.cleanup();
	}
	const calls: unknown[] = [];
	const withJudge = fixtures({ judge: async (artifact) => (calls.push(artifact), { pass: true, reason: "ok" }) });
	try {
		const r = withJudge.store.delegate({ fromUnit: "ceo", toUnit: "vp", goal: "g", contract: JUDGED, budget: tok(10) });
		assert.ok(r.ok);
		withJudge.store.startTask(r.taskId);
		const done = await withJudge.store.completeTask(r.taskId, { x: 1 });
		assert.ok(done.ok);
		assert.deepEqual(calls, [{ x: 1 }]);
	} finally {
		withJudge.cleanup();
	}
});
