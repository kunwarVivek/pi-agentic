/**
 * S5 tests: the `pi-control` entrypoint wiring (ControlServer + Dispatcher +
 * Scheduler) and the Scheduler's combined sweep. The scheduler is driven by
 * hand (autoStart: false) with an injected fake spawner and fake clock so no
 * real worker launches and no wall-clock timer runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseManifest, type Budget, type Manifest } from "@agentic-pi/core";
import type { Contract } from "@agentic-pi/core";
import { startControlPlane } from "../src/control-plane.ts";
import type { WorkerSpec } from "../src/dispatcher.ts";

const BIG: Budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };
const DAY = 24 * 60 * 60 * 1000;
const man = (id: string, path: string, parent: string | null, extra: object = {}): Manifest =>
	parseManifest({ id, path, parent, owner: `${id}@co`, grants: ["tool:read", "delegate:*"], budget: BIG, ...extra });

const CONTRACT: Contract = {
	schema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string", minLength: 1 } } },
};
const smallBudget: Budget = { tokens: 500, costUsd: 1, wallClockSec: 60 };

function harness() {
	const dir = mkdtempSync(join(tmpdir(), "agentic-pi-plane-"));
	return { dbPath: join(dir, "control.db"), socketPath: join(dir, "control.sock"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("startControlPlane wires server + dispatcher + scheduler and dispatches a pending task", async () => {
	const { dbPath, socketPath, cleanup } = harness();
	const t = Date.parse("2026-01-01T00:00:00.000Z");
	const spawned: WorkerSpec[] = [];
	const plane = await startControlPlane({
		dbPath,
		socketPath,
		autoStart: false,
		clock: () => t,
		spawner: (spec) => void spawned.push(spec),
	});
	try {
		plane.store.addUnit(man("ceo", "ceo", null));
		plane.store.addUnit(man("sales", "sales", "ceo"));
		const d = plane.store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);

		const result = await plane.scheduler.sweep();
		assert.deepEqual(result.dispatched, [d.taskId]);
		assert.equal(plane.store.getTask(d.taskId)?.status, "running");
		assert.equal(spawned.length, 1);
		// The dispatcher issued the unit's dev token through the registry.
		assert.ok(spawned[0]!.env.ORG_UNIT_TOKEN && spawned[0]!.env.ORG_UNIT_TOKEN.length > 0);
		assert.equal(spawned[0]!.env.ORG_UNIT_ID, "sales");
	} finally {
		await plane.stop();
		cleanup();
	}
});

test("scheduler sweep suspends an expired unit before dispatch; active sibling still dispatches", async () => {
	const { dbPath, socketPath, cleanup } = harness();
	let t = Date.parse("2026-01-01T00:00:00.000Z");
	const spawned: WorkerSpec[] = [];
	const plane = await startControlPlane({
		dbPath,
		socketPath,
		autoStart: false,
		clock: () => t,
		spawner: (spec) => void spawned.push(spec),
	});
	try {
		const expiresAt = new Date(t + DAY).toISOString();
		plane.store.addUnit(man("ceo", "ceo", null, { expiresAt }));
		plane.store.addUnit(man("sales", "sales", "ceo"));
		const d = plane.store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);

		// Advance past ceo's expiry; sales has no TTL and is well within idle.
		t += DAY + 1;
		const result = await plane.scheduler.sweep();
		assert.ok(result.lifecycle.some((l) => l.unitId === "ceo" && l.to === "suspended"), "ceo suspended");
		assert.equal(plane.store.getUnit("ceo")?.status, "suspended");
		// sales is still active, so its pending task dispatches this same sweep.
		assert.deepEqual(result.dispatched, [d.taskId]);
	} finally {
		await plane.stop();
		cleanup();
	}
});

test("scheduler sweep expires an overdue approval (FR5) alongside dispatch", async () => {
	const { dbPath, socketPath, cleanup } = harness();
	let t = Date.parse("2026-01-01T00:00:00.000Z");
	const plane = await startControlPlane({
		dbPath,
		socketPath,
		autoStart: false,
		clock: () => t,
		spawner: () => {},
	});
	try {
		plane.store.addUnit(man("ceo", "ceo", null));
		plane.store.addUnit(man("sales", "sales", "ceo"));
		const d = plane.store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: smallBudget });
		assert.ok(d.ok);
		plane.store.startTask(d.taskId);
		plane.store.escalate(d.taskId, "approve?", ["yes", "no"]);
		// Default approval TTL is 24h; advance past it. It reroutes to ceo's owner.
		t += DAY + 1;
		const result = await plane.scheduler.sweep();
		assert.equal(result.approvalsExpired, 1, "the overdue approval was handled");
	} finally {
		await plane.stop();
		cleanup();
	}
});
