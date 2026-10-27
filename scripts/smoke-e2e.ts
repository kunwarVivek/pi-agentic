/**
 * S6 smoke: delegate ceo->eng over the live socket, then simulate the worker
 * completing the task with a conforming artifact, and assert it is stored and
 * the gate passed. Exercises the real SocketControlClient round-trip.
 *   node scripts/smoke-e2e.ts <control.db> <socket>
 */
import { ControlStore } from "../src/store/control.ts";
import type { Contract } from "../src/core/gates.ts";

const [db, _socket] = process.argv.slice(2);
if (!db) {
	process.stderr.write("usage: smoke-e2e.ts <control.db> <socket>\n");
	process.exit(2);
}
const contract: Contract = {
	schema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string", minLength: 1 } } },
};
const store = new ControlStore(db, {});
try {
	const d = store.delegate({ fromUnit: "ceo", toUnit: "eng", goal: "smoke build", contract, budget: { tokens: 1000, costUsd: 1, wallClockSec: 100 } });
	if (!d.ok) throw new Error(`delegate rejected: ${d.code} ${d.reason}`);
	store.startTask(d.taskId);
	const result = await store.completeTask(d.taskId, { summary: "ok" });
	if (!result.ok) throw new Error(`gate failed: ${JSON.stringify(result)}`);
	const task = store.getTask(d.taskId);
	if (task?.status !== "done" || !task.artifactHash) throw new Error(`task not done: ${JSON.stringify(task)}`);
	if (!store.getArtifact(task.artifactHash)) throw new Error("artifact not stored");
	process.stdout.write(`e2e ok: task ${d.taskId} done, artifact ${task.artifactHash}\n`);
} finally {
	store.close();
}
