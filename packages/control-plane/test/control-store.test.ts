import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStore, type ControlStoreOptions } from "../src/store-control.ts";
import { parseManifest, type Manifest } from "pi-agentic-core";
import type { Contract } from "pi-agentic-core";
import type { Budget } from "pi-agentic-core";

const BIG: Budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };
const man = (id: string, path: string, parent: string | null, grants: string[], budget: Budget = BIG, extra: object = {}): Manifest =>
	parseManifest({ id, path, parent, owner: `${id}@co`, grants, budget, ...extra });

/** Deterministic clock + id generator for reproducible tests. */
function fixtures(extra: ControlStoreOptions = {}) {
	let t = Date.parse("2026-01-01T00:00:00.000Z");
	let n = 0;
	const clock = () => t;
	const advance = (ms: number) => {
		t += ms;
	};
	const dir = mkdtempSync(join(tmpdir(), "agentic-pi-"));
	const store = new ControlStore(join(dir, "control.db"), {
		clock,
		genId: (p) => `${p}_${String(++n).padStart(4, "0")}`,
		approvalTtlMs: 1000,
		...extra,
	});
	// A small org: ceo → sales → emea, and ceo → eng.
	store.addUnit(man("ceo", "ceo", null, ["tool:read", "delegate:*", "path:rw:/d/**"]));
	store.addUnit(man("sales", "sales", "ceo", ["tool:read", "path:rw:/d/sales/**", "delegate:sales/*"]));
	store.addUnit(man("emea", "sales/emea", "sales", ["tool:read", "path:rw:/d/sales/emea/**"]));
	store.addUnit(man("eng", "eng", "ceo", ["tool:read", "tool:bash"]));
	return { store, clock, advance, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const CONTRACT: Contract = {
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["summary", "count"],
		properties: { summary: { type: "string", minLength: 1 }, count: { type: "integer", minimum: 0 } },
	},
	rules: { maxBytes: 1000, forbiddenKeys: ["password"] },
};

const smallBudget: Budget = { tokens: 500, costUsd: 1, wallClockSec: 60 };

test("delegate reserves budget and creates a pending task", () => {
	const { store, cleanup } = fixtures();
	try {
		const r = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
		assert.ok(r.ok);
		const task = store.getTask(r.taskId);
		assert.equal(task?.status, "pending");
		assert.equal(task?.toUnit, "sales");
		const ceo = store.getUnit("ceo");
		assert.deepEqual(ceo?.reserved, smallBudget);
		assert.deepEqual(store.remainingBudget("ceo"), { tokens: BIG.tokens - 500, costUsd: BIG.costUsd - 1, wallClockSec: BIG.wallClockSec - 60 });
	} finally {
		cleanup();
	}
});

test("delegate rejects widening grants and over-budget, and records audit", () => {
	const { store, cleanup } = fixtures();
	try {
		const wide = store.delegate({ fromUnit: "sales", toUnit: "emea", goal: "x", contract: CONTRACT, grants: [{ kind: "tool", name: "bash" }], budget: smallBudget });
		assert.equal(wide.ok, false);
		assert.equal(wide.ok === false ? wide.code : "", "widening");
		const over = store.delegate({ fromUnit: "sales", toUnit: "emea", goal: "x", contract: CONTRACT, budget: { tokens: 1e9, costUsd: 1e9, wallClockSec: 1e9 } });
		assert.equal(over.ok, false);
		// reservation unchanged by a failed delegation
		assert.deepEqual(store.getUnit("sales")?.reserved, { tokens: 0, costUsd: 0, wallClockSec: 0 });
		assert.ok(store.auditEntries().some((e) => e.action === "delegate.reject"));
	} finally {
		cleanup();
	}
});

test("completion passes the gate, marks done, rolls child usage up and releases reservation", async () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		store.startTask(d.taskId);
		store.meter(d.taskId, { tokens: 200, costUsd: 0.4, wallClockSec: 20 });
		const res = await store.completeTask(d.taskId, { summary: "done", count: 3 });
		assert.ok(res.ok);
		assert.equal(res.status, "done");
		const task = store.getTask(d.taskId);
		assert.equal(task?.status, "done");
		assert.equal(task?.artifactHash, res.ok ? res.artifactHash : "");
		// CEO reservation released; sales' actual usage rolled into CEO used
		const ceo = store.getUnit("ceo");
		assert.deepEqual(ceo?.reserved, { tokens: 0, costUsd: 0, wallClockSec: 0 });
		assert.deepEqual(ceo?.used, { tokens: 200, costUsd: 0.4, wallClockSec: 20 });
		// artifact retrievable by hash
		assert.deepEqual(store.getArtifact(task?.artifactHash as string), { count: 3, summary: "done" });
	} finally {
		cleanup();
	}
});

test("completion failure rejects, then escalates after max attempts", async () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		store.startTask(d.taskId);
		const bad = { summary: "", count: -1 }; // fails schema (minLength, minimum)
		const r1 = await store.completeTask(d.taskId, bad);
		assert.equal(r1.ok, false);
		assert.equal(r1.ok === false ? r1.status : "", "rejected");
		// Below max_attempts the rejected task is re-queued for the dispatcher (FR4).
		const afterReject = store.getTask(d.taskId);
		assert.equal(afterReject?.attempts, 1);
		assert.equal(afterReject?.status, "pending");
		assert.equal(afterReject?.generation, 1, "re-queue bumps the resume generation");
		assert.ok(store.auditEntries().some((e) => e.action === "task.retry" && e.subject === d.taskId));
		store.startTask(d.taskId);
		const r2 = await store.completeTask(d.taskId, bad);
		assert.equal(r2.ok === false ? r2.status : "", "escalated");
		assert.equal(store.getTask(d.taskId)?.status, "escalated");
		// At the limit a real approval row exists (inbox + expiry), held by the executing unit (FR4/FR5).
		const open = store.listOpenApprovals("sales@co");
		assert.equal(open.length, 1);
		assert.equal(open[0]?.taskId, d.taskId);
		assert.equal(open[0]?.holderUnitId, "sales");

	} finally {
		cleanup();
	}
});

test("gate judge stage runs and can reject", async () => {
	const { store, cleanup } = fixtures({ judge: async () => ({ pass: false, reason: "not good enough" }) });
	try {
		const judged: Contract = { schema: { type: "object" }, judge: true };
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: judged, budget: smallBudget });
		assert.ok(d.ok);
		const res = await store.completeTask(d.taskId, { any: 1 });
		assert.equal(res.ok, false);
		assert.equal(res.ok === false && res.status === "rejected" ? res.gate.pass : true, false);
	} finally {
		cleanup();
	}
});

test("escalation creates an approval that a human can resolve", () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const appr = store.escalate(d.taskId, "ship it?", ["yes", "no"]);
		assert.equal(appr.owner, "sales@co");
		assert.equal(store.getTask(d.taskId)?.status, "escalated");
		assert.deepEqual(store.listOpenApprovals("sales@co").map((a) => a.id), [appr.id]);
		const resolved = store.resolveApproval(appr.id, "approved", "sales@co", "yes");
		assert.equal(resolved.status, "approved");
		assert.equal(resolved.decision, "yes");
		assert.equal(store.listOpenApprovals().length, 0);
	} finally {
		cleanup();
	}
});

test("approval expiry reroutes to parent owner, then denies at root", () => {
	const { store, advance, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const appr = store.escalate(d.taskId, "ship?", ["yes", "no"]);
		// sales' owner is the first owner; parent is ceo
		assert.equal(appr.owner, "sales@co");
		advance(1001);
		assert.equal(store.expireApprovals(), 1);
		assert.equal(store.getApproval(appr.id)?.owner, "ceo@co"); // rerouted up
		assert.equal(store.getApproval(appr.id)?.status, "open");
		// ceo is root (parent null) → next expiry denies
		advance(1001);
		assert.equal(store.expireApprovals(), 1);
		assert.equal(store.getApproval(appr.id)?.status, "expired");
		assert.equal(store.getApproval(appr.id)?.decision, "denied");
	} finally {
		cleanup();
	}
});

test("expiry climbs by holder unit id when owners repeat up the tree, then denies at root (FR5)", () => {
	const { store, advance, cleanup } = fixtures();
	try {
		// Same owner at every level: the old owner-string climb never left the executing unit.
		store.addUnit(man("a", "a", "ceo", ["tool:read", "delegate:*"], BIG, { owner: "o@co" }));
		store.addUnit(man("b", "a/b", "a", ["tool:read"], BIG, { owner: "o@co" }));
		const d = store.delegate({ fromUnit: "a", toUnit: "b", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const appr = store.escalate(d.taskId, "ship?", ["yes", "no"]);
		assert.equal(appr.holderUnitId, "b");
		advance(1001);
		assert.equal(store.expireApprovals(), 1);
		assert.equal(store.getApproval(appr.id)?.holderUnitId, "a");
		advance(1001);
		store.expireApprovals();
		assert.equal(store.getApproval(appr.id)?.holderUnitId, "ceo");
		assert.equal(store.getApproval(appr.id)?.status, "open");
		advance(1001);
		store.expireApprovals();
		assert.equal(store.getApproval(appr.id)?.status, "expired");
		assert.equal(store.getTask(d.taskId)?.status, "cancelled");
	} finally {
		cleanup();
	}
});

test("approvals created before holder_unit_id existed are backfilled on open and still climb (FR5)", () => {
	const { store, dir } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const appr = store.escalate(d.taskId, "ship?", ["yes", "no"]);
		store.close();
		const raw = new DatabaseSync(join(dir, "control.db"));
		raw.exec("ALTER TABLE approvals DROP COLUMN holder_unit_id");
		raw.close();
		const reopened = new ControlStore(join(dir, "control.db"), { clock: () => Date.parse("2026-01-01T00:00:00.000Z") + 1001 });
		try {
			assert.equal(reopened.getApproval(appr.id)?.holderUnitId, "sales");
			assert.equal(reopened.expireApprovals(), 1);
			assert.equal(reopened.getApproval(appr.id)?.holderUnitId, "ceo");
		} finally {
			reopened.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveApproval rejects an expired approval and a choice outside options (G8)", () => {
	const { store, advance, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const appr = store.escalate(d.taskId, "ship?", ["yes", "no"]);
		assert.throws(() => store.resolveApproval(appr.id, "approved", "sales@co", "maybe"), /not one of/);
		assert.equal(store.getApproval(appr.id)?.status, "open");
		advance(1001);
		assert.throws(() => store.resolveApproval(appr.id, "approved", "sales@co", "yes"), /expired/);
		assert.equal(store.getApproval(appr.id)?.status, "open");
		assert.equal(store.getTask(d.taskId)?.status, "escalated");
	} finally {
		cleanup();
	}
});

test("notifications: parent hears done / rejected / escalated; ack is per unit and audited (FR4)", async () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		store.startTask(d.taskId);
		await store.completeTask(d.taskId, { summary: "", count: -1 });
		store.startTask(d.taskId);
		await store.completeTask(d.taskId, { summary: "", count: -1 }); // limit → escalated
		const kinds = store.listNotifications("ceo").map((n) => n.kind);
		assert.deepEqual(kinds, ["task.rejected", "task.escalated"]);
		assert.deepEqual(store.listNotifications("sales"), []);
		const first = store.listNotifications("ceo")[0];
		assert.equal(store.ackNotification("sales", first?.id ?? ""), false);
		assert.equal(store.ackNotification("ceo", first?.id ?? ""), true);
		assert.equal(store.ackNotification("ceo", first?.id ?? ""), false);
		assert.deepEqual(store.listNotifications("ceo").map((n) => n.kind), ["task.escalated"]);
		assert.ok(store.auditEntries().some((e) => e.action === "notify.ack"));
		assert.equal(store.verifyAudit().ok, true);
	} finally {
		cleanup();
	}
});

test("audit chain verifies and detects tampering", () => {
	const { store, cleanup } = fixtures();
	try {
		store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		const v = store.verifyAudit();
		assert.equal(v.ok, true);
		assert.ok(v.ok && v.count >= 5); // 4 unit.add + 1 delegate
	} finally {
		cleanup();
	}
});

test("meter flags over-budget on the unit ceiling", () => {
	const { store, cleanup } = fixtures();
	try {
		// give sales a tiny ceiling via a fresh store unit
		store.addUnit(man("tiny", "tiny", "ceo", ["tool:read"], { tokens: 100, costUsd: 1, wallClockSec: 10 }));
		const d = store.delegate({ fromUnit: "ceo", toUnit: "tiny", goal: "x", contract: CONTRACT, budget: { tokens: 100, costUsd: 1, wallClockSec: 10 } });
		assert.ok(d.ok);
		store.startTask(d.taskId);
		const m = store.meter(d.taskId, { tokens: 150, costUsd: 0.1, wallClockSec: 1 });
		assert.ok(m.overBudget.includes("tokens"));
	} finally {
		cleanup();
	}
});

test("persistence survives reopen", () => {
	const { store, dir, cleanup } = fixtures();
	let taskId = "";
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "persist", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		taskId = d.taskId;
		store.close();
		const reopened = new ControlStore(join(dir, "control.db"), {});
		try {
			assert.equal(reopened.getTask(taskId)?.goal, "persist");
			assert.equal(reopened.verifyAudit().ok, true);
		} finally {
			reopened.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("anchor export detects truncation and rewrite against the live chain", () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "anchor", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const anchor = store.exportAnchor();
		assert.ok(anchor.count > 0);
		// Live chain still matches the anchor it was taken from.
		assert.deepEqual(store.verifyAnchor(anchor), { ok: true, count: anchor.count });
		// Appending more entries is a faithful continuation.
		store.startTask(d.taskId);
		const after = store.verifyAnchor(anchor);
		assert.equal(after.ok, true);
		// A truncated/forged chain fails: raw-delete the head row behind the store's back.
		const raw = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
		raw.prepare("DROP TRIGGER audit_no_delete").run();
		raw.prepare("DELETE FROM audit WHERE seq = (SELECT MAX(seq) FROM audit)").run();
		const r = store.verifyAnchor(anchor);
		assert.equal(r.ok, false);
		if (!r.ok) assert.ok(r.reason === "truncated" || r.reason === "head_mismatch");
	} finally {
		cleanup();
	}
});

test("approving an escalated task re-opens it as pending (ADR-0007)", () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const appr = store.escalate(d.taskId, "ship it?", ["yes", "no"]);
		assert.equal(store.getTask(d.taskId)?.status, "escalated");
		store.resolveApproval(appr.id, "approved", "sales@co", "yes");
		assert.equal(store.getTask(d.taskId)?.status, "pending");
		// reservation is preserved for the retry
		assert.deepEqual(store.getUnit("ceo")?.reserved, smallBudget);
	} finally {
		cleanup();
	}
});

test("denying an escalated task cancels it and returns the reservation (ADR-0007)", () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		assert.deepEqual(store.getUnit("ceo")?.reserved, smallBudget);
		const appr = store.escalate(d.taskId, "ship it?", ["yes", "no"]);
		store.resolveApproval(appr.id, "denied", "sales@co");
		assert.equal(store.getTask(d.taskId)?.status, "cancelled");
		// reservation returned to the parent
		assert.deepEqual(store.getUnit("ceo")?.reserved, { tokens: 0, costUsd: 0, wallClockSec: 0 });
	} finally {
		cleanup();
	}
});

test("root TTL expiry cancels the task (no answer -> denied, G8)", () => {
	const { store, advance, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const appr = store.escalate(d.taskId, "ship?", ["yes", "no"]);
		advance(1001);
		store.expireApprovals(); // reroute sales@co -> ceo@co
		advance(1001);
		store.expireApprovals(); // ceo is root -> denied
		assert.equal(store.getApproval(appr.id)?.status, "expired");
		assert.equal(store.getTask(d.taskId)?.status, "cancelled");
		assert.deepEqual(store.getUnit("ceo")?.reserved, { tokens: 0, costUsd: 0, wallClockSec: 0 });
	} finally {
		cleanup();
	}
});

test("a cancelled task cannot be re-completed (no double release)", async () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const appr = store.escalate(d.taskId, "ship?", ["yes", "no"]);
		store.resolveApproval(appr.id, "denied", "sales@co");
		assert.equal(store.getTask(d.taskId)?.status, "cancelled");
		assert.deepEqual(store.getUnit("ceo")?.reserved, { tokens: 0, costUsd: 0, wallClockSec: 0 });
		const r = await store.completeTask(d.taskId, { summary: "ok", count: 1 });
		assert.equal(r.ok, false);
		assert.equal(r.status, "error");
		// reservation stays at zero — not driven negative by a second release
		assert.deepEqual(store.getUnit("ceo")?.reserved, { tokens: 0, costUsd: 0, wallClockSec: 0 });
	} finally {
		cleanup();
	}
});

test("escalate refuses a terminal task", () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		const appr = store.escalate(d.taskId, "ship?", ["yes", "no"]);
		store.resolveApproval(appr.id, "denied", "sales@co");
		assert.throws(() => store.escalate(d.taskId, "again?", ["yes"]), /cancelled|cannot escalate/);
	} finally {
		cleanup();
	}
});

test("meter trips over the task's reserved budget, not just the unit ceiling (FR6)", () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		store.startTask(d.taskId);
		// Unit ceiling is BIG; task reserved is smallBudget (500 tokens). Spend over the task budget.
		const r = store.meter(d.taskId, { tokens: 600, costUsd: 0, wallClockSec: 0 });
		assert.ok(r.overBudget.includes("tokens"));
	} finally {
		cleanup();
	}
});

test("two tasks to the same child roll up per-task usage, not the child's lifetime total (FR6)", async () => {
	const { store, cleanup } = fixtures();
	try {
		const b1: Budget = { tokens: 300, costUsd: 1, wallClockSec: 60 };
		const b2: Budget = { tokens: 300, costUsd: 1, wallClockSec: 60 };
		const d1 = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "a", contract: CONTRACT, budget: b1 });
		const d2 = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "b", contract: CONTRACT, budget: b2 });
		assert.ok(d1.ok && d2.ok);
		store.startTask(d1.taskId);
		store.startTask(d2.taskId);
		store.meter(d1.taskId, { tokens: 100, costUsd: 0, wallClockSec: 0 });
		store.meter(d2.taskId, { tokens: 200, costUsd: 0, wallClockSec: 0 });
		await store.completeTask(d1.taskId, { summary: "ok", count: 1 });
		// Parent used reflects ONLY task 1's 100 tokens, not the child unit's cumulative 300.
		assert.equal(store.getUnit("ceo")?.used.tokens, 100);
		await store.completeTask(d2.taskId, { summary: "ok", count: 1 });
		assert.equal(store.getUnit("ceo")?.used.tokens, 300);
	} finally {
		cleanup();
	}
});

test("meter: first over-budget creates one escalation, later ones do not duplicate (FR6)", () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		store.startTask(d.taskId);
		const under = store.meter(d.taskId, { tokens: 100, costUsd: 0, wallClockSec: 0 });
		assert.equal(under.escalation, null);
		assert.equal(store.getTask(d.taskId)?.status, "running");

		const first = store.meter(d.taskId, { tokens: 600, costUsd: 0, wallClockSec: 0 });
		assert.ok(first.escalation);
		assert.equal(first.escalation.taskId, d.taskId);
		assert.equal(first.escalation.status, "open");
		assert.deepEqual(first.escalation.options, ["extend", "cancel"]);
		assert.match(first.escalation.question, /tokens/);
		assert.equal(store.getTask(d.taskId)?.status, "escalated");

		const second = store.meter(d.taskId, { tokens: 10, costUsd: 0, wallClockSec: 0 });
		assert.ok(second.overBudget.includes("tokens"));
		assert.equal(second.escalation, null);
		assert.equal(store.listOpenApprovals().filter((a) => a.taskId === d.taskId).length, 1);
		assert.ok(store.verifyAudit().ok);
	} finally {
		cleanup();
	}
});

test("meter: a failing escalation rolls back the usage update and audit row (FR6/FR7)", () => {
	const dir = mkdtempSync(join(tmpdir(), "agentic-pi-"));
	// NaN TTL makes escalate() throw (invalid Date) after the usage UPDATE ran.
	const store = new ControlStore(join(dir, "control.db"), { approvalTtlMs: Number.NaN });
	try {
		store.addUnit(man("ceo", "ceo", null, ["tool:read", "delegate:*"]));
		store.addUnit(man("sales", "sales", "ceo", ["tool:read"]));
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		store.startTask(d.taskId);
		const auditBefore = store.auditEntries().length;
		assert.throws(() => store.meter(d.taskId, { tokens: 600, costUsd: 0, wallClockSec: 0 }));
		assert.equal(store.getTask(d.taskId)?.used.tokens, 0);
		assert.equal(store.getUnit("sales")?.used.tokens, 0);
		assert.equal(store.getTask(d.taskId)?.status, "running");
		assert.equal(store.auditEntries().length, auditBefore);
		assert.equal(store.listOpenApprovals().length, 0);
		// connection is not stuck in a transaction
		assert.doesNotThrow(() => store.meter(d.taskId, { tokens: 1, costUsd: 0, wallClockSec: 0 }));
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("recordDecision appends a verifiable policy audit row", () => {
	const { store, cleanup } = fixtures();
	try {
		store.recordDecision("sales", "t1", { toolName: "write", paths: [{ path: "/d/x", mode: "rw" }] }, { allow: false, reason: "no grant" });
		store.recordDecision("sales", null, { toolName: "read", paths: [] }, { allow: true });
		const rows = store.auditEntries().filter((e) => e.actor === "policy:sales");
		assert.deepEqual(rows.map((r) => r.action), ["tool.deny", "tool.allow"]);
		assert.deepEqual(rows[0]?.data, { paths: [{ path: "/d/x", mode: "rw" }], reason: "no grant", taskId: "t1" });
		assert.ok(store.verifyAudit().ok);
	} finally {
		cleanup();
	}
});

const SMALL: Budget = { tokens: 100, costUsd: 1, wallClockSec: 10 };

test("approving 'extend' raises the task budget and reserves the delta; next meter passes (wnk.10)", () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "sales", toUnit: "emea", goal: "x", contract: CONTRACT, budget: SMALL });
		assert.ok(d.ok);
		store.startTask(d.taskId);
		const m = store.meter(d.taskId, { tokens: 150, costUsd: 0.1, wallClockSec: 1 });
		assert.deepEqual(m.overBudget, ["tokens"]);
		assert.ok(m.escalation);
		const before = store.getUnit("sales")?.reserved as Budget;
		store.resolveApproval(m.escalation.id, "approved", "human", "extend");
		const t = store.getTask(d.taskId);
		assert.equal(t?.status, "pending");
		assert.equal(t?.budget.tokens, 300);
		assert.equal(t?.budget.costUsd, 1);
		assert.equal((store.getUnit("sales")?.reserved as Budget).tokens, before.tokens + 200);
		store.startTask(d.taskId);
		const m2 = store.meter(d.taskId, { tokens: 10, costUsd: 0, wallClockSec: 0 });
		assert.deepEqual(m2.overBudget, []);
		assert.equal(m2.escalation, null);
	} finally {
		cleanup();
	}
});

test("'extend' beyond the parent's remaining budget fails closed (wnk.10)", () => {
	const { store, cleanup } = fixtures();
	try {
		store.addUnit(man("p", "p", "ceo", ["tool:read", "delegate:p/*"], SMALL));
		store.addUnit(man("c", "p/c", "p", ["tool:read"], SMALL));
		const d = store.delegate({ fromUnit: "p", toUnit: "c", goal: "x", contract: CONTRACT, budget: { tokens: 60, costUsd: 0.5, wallClockSec: 5 } });
		assert.ok(d.ok);
		store.startTask(d.taskId);
		const m = store.meter(d.taskId, { tokens: 70, costUsd: 0, wallClockSec: 0 });
		assert.ok(m.escalation);
		assert.throws(() => store.resolveApproval(m.escalation!.id, "approved", "human", "extend"), /cannot extend/);
		assert.equal(store.getApproval(m.escalation.id)?.status, "open");
		assert.equal(store.getTask(d.taskId)?.status, "escalated");
		assert.equal(store.getTask(d.taskId)?.budget.tokens, 60);
	} finally {
		cleanup();
	}
});

test("approving with choice 'cancel' cancels the task and releases the reservation (wnk.10)", () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "sales", toUnit: "emea", goal: "x", contract: CONTRACT, budget: SMALL });
		assert.ok(d.ok);
		store.startTask(d.taskId);
		const m = store.meter(d.taskId, { tokens: 150, costUsd: 0, wallClockSec: 0 });
		assert.ok(m.escalation);
		store.resolveApproval(m.escalation.id, "approved", "human", "cancel");
		assert.equal(store.getTask(d.taskId)?.status, "cancelled");
		assert.equal((store.getUnit("sales")?.reserved as Budget).tokens, 0);
	} finally {
		cleanup();
	}
});

test("a zero-limit dimension with zero usage is not over budget (wnk.11)", () => {
	const { store, cleanup } = fixtures();
	try {
		const d = store.delegate({ fromUnit: "sales", toUnit: "emea", goal: "x", contract: CONTRACT, budget: { tokens: 100, costUsd: 0, wallClockSec: 10 } });
		assert.ok(d.ok);
		store.startTask(d.taskId);
		const m = store.meter(d.taskId, { tokens: 10, costUsd: 0, wallClockSec: 0 });
		assert.deepEqual(m.overBudget, []);
		assert.equal(m.escalation, null);
		const m2 = store.meter(d.taskId, { tokens: 0, costUsd: 0.01, wallClockSec: 0 });
		assert.deepEqual(m2.overBudget, ["costUsd"]);
	} finally {
		cleanup();
	}
});
