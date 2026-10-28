import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/store-control.ts";
import { parseManifest, type Manifest, type Budget } from "pi-agentic-core";

const BIG: Budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };

const DAY = 24 * 60 * 60 * 1000;

const man = (id: string, path: string, parent: string | null, extra: object = {}): Manifest =>
	parseManifest({ id, path, parent, owner: `${id}@co`, grants: ["tool:read"], budget: BIG, ...extra });

/** Deterministic clock + id generator; retire idle after 90 days by default. */
function fixtures(opts: { retireIdleMs?: number } = {}) {
	let t = Date.parse("2026-01-01T00:00:00.000Z");
	let n = 0;
	const clock = (): number => t;
	const advance = (ms: number): void => {
		t += ms;
	};
	const dir = mkdtempSync(join(tmpdir(), "agentic-pi-s5-"));
	const store = new ControlStore(join(dir, "control.db"), {
		clock,
		genId: (p) => `${p}_${String(++n).padStart(4, "0")}`,
		...(opts.retireIdleMs !== undefined ? { retireIdleMs: opts.retireIdleMs } : {}),
	});
	return {
		store,
		clock,
		advance,
		cleanup: () => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("sweepLifecycle suspends a unit whose expires_at is past", () => {
	const { store, advance, clock, cleanup } = fixtures();
	try {
		const expiresAt = new Date(clock() + DAY).toISOString();
		store.addUnit(man("ceo", "ceo", null, { expiresAt }));
		// Before expiry: no transition.
		assert.deepEqual(store.sweepLifecycle(), []);
		assert.equal(store.getUnit("ceo")?.status, "active");
		// After expiry: suspended.
		advance(DAY + 1);
		const out = store.sweepLifecycle();
		assert.equal(out.length, 1);
		assert.deepEqual(out[0], { unitId: "ceo", from: "active", to: "suspended", reason: "expired" });
		assert.equal(store.getUnit("ceo")?.status, "suspended");
		// Idempotent: a second sweep does nothing (unit no longer active).
		assert.deepEqual(store.sweepLifecycle(), []);
	} finally {
		cleanup();
	}
});

test("sweepLifecycle retires a unit idle longer than the threshold", () => {
	const { store, advance, cleanup } = fixtures({ retireIdleMs: 90 * DAY });
	try {
		store.addUnit(man("ceo", "ceo", null));
		// created_at is now; 89 days later still active.
		advance(89 * DAY);
		assert.deepEqual(store.sweepLifecycle(), []);
		assert.equal(store.getUnit("ceo")?.status, "active");
		// Past 90 days of inactivity: retired.
		advance(2 * DAY);
		const out = store.sweepLifecycle();
		assert.deepEqual(out, [{ unitId: "ceo", from: "active", to: "retired", reason: "idle" }]);
		assert.equal(store.getUnit("ceo")?.status, "retired");
	} finally {
		cleanup();
	}
});

test("recent activity resets the idle clock so the unit is not retired", () => {
	const { store, advance, cleanup } = fixtures({ retireIdleMs: 90 * DAY });
	try {
		store.addUnit(man("ceo", "ceo", null, { grants: ["tool:read", "delegate:*"] }));
		store.addUnit(man("sales", "sales", "ceo"));
		// A delegation + start touches last_active on sales.
		advance(80 * DAY);
		const d = store.delegate({
			fromUnit: "ceo",
			toUnit: "sales",
			goal: "sell",
			contract: { schema: { type: "object" } },
			budget: { tokens: 10, costUsd: 1, wallClockSec: 10 },
		});
		assert.ok(d.ok);
		store.startTask(d.taskId);
		// 80 more days: created_at is 160d old, but last_active is only 80d old.
		advance(80 * DAY);
		const out = store.sweepLifecycle();
		// sales stays active (last_active recent); ceo never acted so it retires.
		assert.equal(store.getUnit("sales")?.status, "active");
		assert.ok(out.some((t) => t.unitId === "ceo" && t.reason === "idle"));
	} finally {
		cleanup();
	}
});

test("sweepLifecycle deprecates a unit whose eval rate drops below min_eval", () => {
	const { store, cleanup } = fixtures();
	try {
		store.addUnit(man("eng", "eng", null, { minEval: 0.8 }));
		// No eval recorded yet: not deprecated (null rate is not a failure).
		assert.deepEqual(store.sweepLifecycle(), []);
		// A passing eval keeps it active.
		store.recordEval("eng", "regression", 9, 10);
		assert.equal(store.latestEvalRate("eng"), 0.9);
		assert.deepEqual(store.sweepLifecycle(), []);
		assert.equal(store.getUnit("eng")?.status, "active");
		// A later failing eval (latest wins) drops it below 0.8 → deprecated.
		store.recordEval("eng", "regression", 5, 10);
		assert.equal(store.latestEvalRate("eng"), 0.5);
		const out = store.sweepLifecycle();
		assert.deepEqual(out, [{ unitId: "eng", from: "active", to: "deprecated", reason: "low_eval" }]);
		assert.equal(store.getUnit("eng")?.status, "deprecated");
	} finally {
		cleanup();
	}
});

test("a deprecated unit denies new delegations (FR8 via status gate)", () => {
	const { store, cleanup } = fixtures();
	try {
		store.addUnit(man("ceo", "ceo", null, { grants: ["tool:read", "delegate:*"] } as object));
		store.addUnit(man("eng", "eng", "ceo", { minEval: 0.8 }));
		store.recordEval("eng", "regression", 1, 10);
		store.sweepLifecycle();
		assert.equal(store.getUnit("eng")?.status, "deprecated");
		const r = store.delegate({
			fromUnit: "eng",
			toUnit: "eng",
			goal: "x",
			contract: { schema: { type: "object" } },
			budget: { tokens: 1, costUsd: 0, wallClockSec: 1 },
		});
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.code, "from_inactive");
	} finally {
		cleanup();
	}
});

test("expiry takes priority over idle and eval when several rules match", () => {
	const { store, advance, clock, cleanup } = fixtures({ retireIdleMs: DAY });
	try {
		const expiresAt = new Date(clock() + DAY).toISOString();
		store.addUnit(man("x", "x", null, { expiresAt, minEval: 0.9 }));
		store.recordEval("x", "s", 0, 10); // would also trigger low_eval
		advance(10 * DAY); // also well past idle threshold
		const out = store.sweepLifecycle();
		assert.deepEqual(out, [{ unitId: "x", from: "active", to: "suspended", reason: "expired" }]);
	} finally {
		cleanup();
	}
});

test("expires_at is compared as an instant, not a string (FR8)", () => {
	const { store, cleanup } = fixtures();
	try {
		// 01:00+02:00 is 23:00Z the previous day: already past at the fake clock's 00:00Z,
		// yet it sorts after "2026-01-01T00:00:00.000Z" as a string.
		store.addUnit(man("ceo", "ceo", null, { expiresAt: "2026-01-01T01:00:00+02:00" }));
		assert.deepEqual(store.sweepLifecycle(), [{ unitId: "ceo", from: "active", to: "suspended", reason: "expired" }]);
	} finally {
		cleanup();
	}
});

test("a lifecycle transition is addressed to the unit AND to its owner's inbox, even for a human owner (FR8)", () => {
	const { store, clock, advance, cleanup } = fixtures();
	try {
		store.addUnit(man("boss", "boss", null));
		store.addUnit(man("eng", "eng", "boss", { owner: "boss@co", expiresAt: new Date(clock() + DAY).toISOString() }));
		advance(DAY + 1);
		store.sweepLifecycle();
		const data = { from: "active", to: "suspended", reason: "expired", owner: "boss@co" };
		const own = store.listNotifications("eng");
		assert.equal(own.length, 1);
		assert.deepEqual(own[0]?.data, data);
		const inbox = store.listOwnerNotifications("boss@co");
		assert.equal(inbox.length, 1, "owner inbox shows the notice though the unit is suspended and never runs again");
		assert.equal(inbox[0]?.kind, "unit.lifecycle");
		assert.equal(inbox[0]?.subject, "eng");
		assert.deepEqual(store.listOwnerNotifications("someone-else@co"), []);
		assert.equal(store.ackOwnerNotification("someone-else@co", inbox[0]!.id), false, "foreign owner cannot ack");
		assert.equal(store.ackOwnerNotification("boss@co", inbox[0]!.id), true);
		assert.deepEqual(store.listOwnerNotifications("boss@co"), []);
	} finally {
		cleanup();
	}
});

test("a unit with a running task is never retired for idleness (FR8)", () => {
	const { store, advance, cleanup } = fixtures({ retireIdleMs: 90 * DAY });
	try {
		store.addUnit(man("ceo", "ceo", null, { grants: ["tool:read", "delegate:*"] }));
		store.addUnit(man("sales", "sales", "ceo"));
		const d = store.delegate({
			fromUnit: "ceo",
			toUnit: "sales",
			goal: "long job",
			contract: { schema: { type: "object" } },
			budget: { tokens: 10, costUsd: 1, wallClockSec: 10 },
		});
		assert.ok(d.ok);
		store.startTask(d.taskId);
		advance(100 * DAY);
		const out = store.sweepLifecycle();
		assert.equal(store.getUnit("sales")?.status, "active");
		assert.ok(!out.some((t) => t.unitId === "sales"));
	} finally {
		cleanup();
	}
});
