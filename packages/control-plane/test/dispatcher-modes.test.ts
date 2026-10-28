/** Dispatcher worker launch modes (ADR-0009): `pi` is the default; `durable` adds ORG_DURABLE_DIR. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseManifest, type Budget } from "pi-agentic-core";
import { ControlStore } from "../src/store-control.ts";
import { Dispatcher, ENV_DURABLE_DIR, type WorkerSpec } from "../src/dispatcher.ts";

const BIG: Budget = { tokens: 1000, costUsd: 10, wallClockSec: 1000 };

async function dispatchOne(opts: { workerMode?: "pi" | "durable" }): Promise<{ spec: WorkerSpec; dbDir: string }> {
	mkdirSync(join(import.meta.dirname, "../../../.tmp"), { recursive: true });
	const dir = mkdtempSync(join(import.meta.dirname, "../../../.tmp/disp-"));
	const store = new ControlStore(join(dir, "control.db"));
	try {
		store.addUnit(parseManifest({ id: "ceo", path: "ceo", parent: null, owner: "o@co", grants: ["delegate:*"], budget: BIG }));
		store.addUnit(parseManifest({ id: "ops", path: "ops", parent: "ceo", owner: "o@co", grants: ["tool:read"], budget: BIG }));
		const d = store.delegate({ fromUnit: "ceo", toUnit: "ops", goal: "g", contract: { schema: { type: "object" } }, budget: BIG });
		assert.ok(d.ok);
		const specs: WorkerSpec[] = [];
		await new Dispatcher({ store, socketPath: join(dir, "s"), ...opts, spawner: (s) => void specs.push(s) }).tick();
		return { spec: specs[0]!, dbDir: dir };
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("default mode is pi and sets no durable dir", async () => {
	const { spec } = await dispatchOne({});
	assert.equal(spec.mode, "pi");
	assert.equal(ENV_DURABLE_DIR in spec.env, false);
});

test("durable mode sets ORG_DURABLE_DIR under the control state dir, per unit", async () => {
	const { spec, dbDir } = await dispatchOne({ workerMode: "durable" });
	assert.equal(spec.mode, "durable");
	assert.equal(spec.env[ENV_DURABLE_DIR], join(dbDir, "durable", "ops"));
	assert.equal(spec.env.ORG_TASK_ID, spec.task.id);
});
