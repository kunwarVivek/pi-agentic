/**
 * S6 smoke (Linux gate): delegate ceo->eng into control.db, then wait for the
 * LIVE control plane to dispatch it through the real systemd spawner into the
 * rendered `pi-unit@eng.service` (as pi-u-eng, allowlisted env, own unit socket)
 * and for the worker (a probe swapped in by a drop-in) to complete it over its
 * unit socket.
 *   node scripts/smoke-dispatch.ts <control.db> [timeoutSec]
 */
import { ControlStore } from "pi-agentic-control-plane";
import type { Contract } from "pi-agentic-core";

const [db, timeoutArg] = process.argv.slice(2);
if (!db) {
	process.stderr.write("usage: smoke-dispatch.ts <control.db> [timeoutSec]\n");
	process.exit(2);
}
const contract: Contract = {
	schema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string", minLength: 1 } } },
};
const store = new ControlStore(db, {});
try {
	const d = store.delegate({ fromUnit: "ceo", toUnit: "eng", goal: "isolation probe", contract, budget: { tokens: 1000, costUsd: 1, wallClockSec: 100 } });
	if (!d.ok) throw new Error(`delegate rejected: ${d.code} ${d.reason}`);
	const deadline = Date.now() + Number(timeoutArg ?? 60) * 1000;
	for (;;) {
		const t = store.getTask(d.taskId);
		if (t?.status === "done") {
			process.stdout.write(`dispatch ok: ${d.taskId} done via the worker's own unit socket\n`);
			break;
		}
		if (Date.now() > deadline) throw new Error(`task ${d.taskId} still ${t?.status} after timeout (worker probe failed or never started)`);
		await new Promise((r) => setTimeout(r, 500));
	}
} finally {
	store.close();
}
