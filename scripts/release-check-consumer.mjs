/**
 * Consumer-side half of `npm run release:check`. Copied into an isolated dir whose node_modules
 * holds ONLY the packed tarballs (no workspace symlinks) and run with plain `node` from there.
 * It drives the REAL `pi` binary headless against a scripted fake model, with the extension
 * loaded purely from the installed package (`pi install` into PI_CODING_AGENT_DIR; no `-e`).
 * Asserts: 1 out-of-scope read denied, 1 in-scope read allowed, both audited, chain verifies.
 * Usage: node release-check-consumer.mjs <agentDir> <workDir>
 */
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { ControlServer, ControlStore, PeerRegistry } from "pi-agentic-control-plane";
import { parseManifest } from "pi-agentic-core";

const [agentDir, work] = process.argv.slice(2);
const fail = (m) => {
	console.error(`release-check consumer FAIL: ${m}`);
	process.exit(1);
};
const ws = join(work, "eng");
const outside = join(work, "outside", "secret.txt");
mkdirSync(ws, { recursive: true });
mkdirSync(join(work, "outside"), { recursive: true });
writeFileSync(join(ws, "note.txt"), "hello\n");
writeFileSync(outside, "must never be read\n");

const llm = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		const base = { id: "c", object: "chat.completion.chunk", created: 0, model: "fake" };
		const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
		if (!body.includes('"role":"tool"')) {
			[outside, "note.txt"].forEach((p, i) =>
				send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: i, id: `call_${i}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: p }) } }] }, finish_reason: null }] }),
			);
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
		} else {
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		}
		send({ ...base, choices: [], usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 } });
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((r) => llm.listen(0, "127.0.0.1", r));
const port = llm.address().port;
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "fake-model" }] } } }),
);

const big = { tokens: 1_000_000, costUsd: 100, wallClockSec: 100_000 };
const store = new ControlStore(join(work, "control.db"), {});
const eng = { id: "eng", path: "eng", parent: "ceo", owner: "eng@co", grants: ["tool:read", `path:rw:${realpathSync(ws)}/**`], budget: big };
const manifestPath = join(work, "unit.json");
writeFileSync(manifestPath, JSON.stringify(eng));
store.addUnit(parseManifest({ id: "ceo", path: "ceo", parent: null, owner: "ceo@co", grants: ["tool:read", "delegate:*"], budget: big }));
store.addUnit(parseManifest(eng));
const d = store.delegate({ fromUnit: "ceo", toUnit: "eng", goal: "release-check", contract: { schema: { type: "object" } }, budget: { tokens: 1_000_000, costUsd: 10, wallClockSec: 3600 } });
if (!d.ok) fail(`delegate rejected: ${d.reason}`);
const registry = new PeerRegistry();
const token = registry.issueToken("eng");
const server = new ControlServer({ store, auth: registry });
const socketPath = join(work, "c.sock");
await server.listen(socketPath);

// No `-e`, no `-ne`: the only way the gate can exist is the package installed into agentDir.
const child = spawn("pi", ["-p", "--mode", "json", "--model", "fake/fake-model", "do the steps"], {
	cwd: ws,
	timeout: 90_000,
	stdio: ["ignore", "ignore", "pipe"],
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ORG_UNIT_ID: "eng", ORG_UNIT_MANIFEST: manifestPath, ORG_CONTROL_SOCKET: socketPath, ORG_UNIT_TOKEN: token, ORG_TASK_ID: d.taskId },
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));
const code = await new Promise((res, rej) => (child.on("error", rej), child.on("close", res)));
await server.close();
llm.close();
if (code !== 0) fail(`pi exited ${code}: ${stderr}`);
const policy = store.auditEntries().filter((e) => e.actor === "policy:eng");
const denies = policy.filter((e) => e.action === "tool.deny").length;
const allows = policy.filter((e) => e.action === "tool.allow").length;
if (denies !== 1 || allows !== 1) fail(`expected 1 deny + 1 allow from the installed extension, got ${denies} + ${allows}`);
if (!store.verifyAudit().ok) fail("audit chain does not verify");
if ((store.getTask(d.taskId)?.used.tokens ?? 0) <= 0) fail("metering recorded zero tokens");
store.close();
console.log(`ok: installed extension loaded in pi: ${denies} deny + ${allows} allow audited, chain verifies, tokens metered`);
