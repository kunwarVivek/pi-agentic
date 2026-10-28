#!/usr/bin/env node
/**
 * agentic-pi-durable-worker: the dispatcher's `durable` worker mode. Reads the
 * ORG_* environment the dispatcher wires, runs the task in a pi-durable
 * Harness and exits 0 only when the task is completed or handed to a human.
 */

import { modelFromEnv, modelsFromEnv } from "./model-config.ts";
import { runDurableTask } from "./run.ts";

const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => ac.abort());

try {
	const result = await runDurableTask({
		env: process.env,
		models: modelsFromEnv(process.env),
		model: modelFromEnv(process.env),
		...(process.env.ORG_WORKSPACE ? { cwd: process.env.ORG_WORKSPACE } : {}),
		signal: ac.signal,
	});
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exitCode = result.outcome === "completed" || result.outcome === "escalated" || result.outcome === "over_budget" ? 0 : 1;
} catch (e) {
	process.stderr.write(`agentic-pi-durable-worker: ${e instanceof Error ? e.message : String(e)}\n`);
	process.exitCode = 2;
}
