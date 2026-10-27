import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/store-control.ts";
import { parseManifest, type Manifest } from "@agentic-pi/core";
import type { Contract } from "@agentic-pi/core";
import type { Budget } from "@agentic-pi/core";

const BIG: Budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };
const man = (id: string, path: string, parent: string | null, grants: string[], budget: Budget = BIG, extra: object = {}): Manifest =>
	parseManifest({ id, path, parent, owner: `${id}@co`, grants, budget, ...extra });

/** Deterministic clock + id generator for reproducible tests. */
function fixtures() {
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
		assert.equal(store.getTask(d.taskId)?.attempts, 1);
		store.retryTask(d.taskId);
		const r2 = await store.completeTask(d.taskId, bad);
		assert.equal(r2.ok === false ? r2.status : "", "escalated");
		assert.equal(store.getTask(d.taskId)?.status, "escalated");
	} finally {
		cleanup();
	}
});

test("gate judge stage runs and can reject", async () => {
	const { store, cleanup } = fixtures();
	try {
		const judged: Contract = { schema: { type: "object" }, judge: true };
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: judged, budget: smallBudget });
		assert.ok(d.ok);
		const res = await store.completeTask(d.taskId, { any: 1 }, async () => ({ pass: false, reason: "not good enough" }));
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
