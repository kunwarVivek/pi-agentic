/**
 * Smoke: load the org extension into the REAL `pi` binary (headless, json
 * mode) against a scripted OpenAI-compatible fake model, and assert the Pi
 * 1.4.0 host contract end to end:
 *   - tool_call PEP denies out-of-scope reads, including the "@/..." and
 *     "../" spellings Pi itself resolves (FR2), and allows in-scope reads;
 *   - every PDP decision lands in the audit chain and the chain verifies (FR7);
 *   - secrets in tool results never reach the model (FR9);
 *   - turn_end metering is non-zero, and an over-budget task aborts after the
 *     first turn and raises exactly one escalation (FR6).
 * Portable (Linux/macOS). All state lives in a temp dir under ./.tmp of the
 * repo and is removed afterwards. Needs `pi` on PATH; no real model or keys.
 *   npm run smoke:pi
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { ControlServer, ControlStore, PeerRegistry } from "pi-agentic-control-plane";
import { parseManifest } from "pi-agentic-core";

const repo = resolve(import.meta.dirname, "..");
const entry = join(repo, "packages/extension/src/index.ts");
const SECRET = "sk-proj-SMOKEabcdefghijklmnopqrstuvwxyz0123";
const requests: string[] = [];
/** Per-run file outside the granted workspace (still inside the repo temp dir). */
let outside = "";
const fail = (msg: string): never => {
	throw new Error(`smoke-pi-ext FAIL: ${msg}`);
};

// Turn 1 issues the tool calls; a request that already carries tool results ends the run.
const llm = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		requests.push(body);
		const hasToolResults = body.includes('"role":"tool"');
		res.writeHead(200, { "content-type": "text/event-stream" });
		const base = { id: `c${requests.length}`, object: "chat.completion.chunk", created: 0, model: "fake" };
		const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
		if (!hasToolResults) {
			const calls: Array<[string, unknown]> = [
				["read", { path: outside }],
				["read", { path: `@${outside}` }],
				["read", { path: "../outside/secret.txt" }],
				["read", { path: "note.txt" }],
			];
			calls.forEach(([name, args], i) =>
				send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: i, id: `call_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
			);
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
		} else {
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		}
		send({ ...base, choices: [], usage: { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 } });
		res.end("data: [DONE]\n\n");
	});
});
const listening = Promise.withResolvers<void>();
llm.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const addr = llm.address();
if (addr === null || typeof addr === "string") throw new Error("fake model server has no TCP port");
const port = addr.port;

mkdirSync(join(repo, ".tmp"), { recursive: true });
const work = mkdtempSync(join(repo, ".tmp", "pi-ext-smoke-"));

/** One headless pi run as unit eng on a fresh task. Async: the fake model shares this event loop. */
async function run(label: string, tokens: number): Promise<{ store: ControlStore; taskId: string }> {
	requests.length = 0;
	const dir = join(work, label);
	const ws = join(dir, "eng");
	const agentDir = join(dir, "agent");
	mkdirSync(ws, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(ws, "note.txt"), `hello\napi_key=${SECRET}\n`);
	mkdirSync(join(dir, "outside"), { recursive: true });
	outside = join(dir, "outside", "secret.txt");
	writeFileSync(outside, "must never be read\n");
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "fake-model" }] } } }),
	);
	const big = { tokens: 1_000_000, costUsd: 100, wallClockSec: 100_000 };
	const store = new ControlStore(join(dir, "control.db"), {});
	const engManifest = { id: "eng", path: "eng", parent: "ceo", owner: "eng@co", grants: ["tool:read", `path:rw:${realpathSync(ws)}/**`], budget: big };
	const manifestPath = join(dir, "unit.json"); // outside the workspace: the worker cannot rewrite its own manifest
	writeFileSync(manifestPath, JSON.stringify(engManifest));
	store.addUnit(parseManifest({ id: "ceo", path: "ceo", parent: null, owner: "ceo@co", grants: ["tool:read", "delegate:*"], budget: big }));
	// Grants are matched against realpaths, so grant the canonical workspace path.
	store.addUnit(parseManifest(engManifest));
	const d = store.delegate({ fromUnit: "ceo", toUnit: "eng", goal: "smoke", contract: { schema: { type: "object" } }, budget: { tokens, costUsd: 10, wallClockSec: 3600 } });
	if (!d.ok) return fail(`${label}: delegate rejected: ${d.reason}`);
	// Production transport (ADR-0003): the worker talks to a ControlServer over a unix
	// socket with a unit token and never opens control.db (ORG_CONTROL_DB points at a path it must not touch).
	const registry = new PeerRegistry();
	const token = registry.issueToken("eng");
	const server = new ControlServer({ store, auth: registry });
	const socketPath = join(dir, "c.sock");
	await server.listen(socketPath);
	const untouched = join(dir, "worker-must-not-open.db");
	// stdin must be closed: `pi -p` otherwise waits to read piped stdin as part of the prompt.
	const child = spawn("pi", ["-p", "--mode", "json", "-ne", "--model", "fake/fake-model", "-e", entry, "do the steps"], {
		cwd: ws,
		timeout: 60_000,
		stdio: ["ignore", "ignore", "pipe"],
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ORG_UNIT_ID: "eng", ORG_UNIT_MANIFEST: manifestPath, ORG_CONTROL_DB: untouched, ORG_CONTROL_SOCKET: socketPath, ORG_UNIT_TOKEN: token, ORG_TASK_ID: d.taskId },
	});
	let stderr = "";
	child.stderr.on("data", (c) => (stderr += c));
	const exited = Promise.withResolvers<number | null>();
	child.on("error", exited.reject);
	child.on("close", exited.resolve);
	const code = await exited.promise.finally(() => server.close());
	if (existsSync(untouched)) fail(`${label}: worker opened control.db directly (${untouched})`);
	if (code !== 0) fail(`${label}: pi exited ${code}: ${stderr}`);
	return { store, taskId: d.taskId };
}

try {
	// 1. Under budget: PEP + audit + redaction + metering.
	{
		const { store, taskId } = await run("allow", 1_000_000);
		const policy = store.auditEntries().filter((e) => e.actor === "policy:eng");
		const denies = policy.filter((e) => e.action === "tool.deny").length;
		const allows = policy.filter((e) => e.action === "tool.allow").length;
		if (denies !== 3 || allows !== 1) fail(`expected 3 deny + 1 allow policy rows, got ${denies} + ${allows}`);
		if (!store.verifyAudit().ok) fail("audit chain does not verify");
		if ((store.getTask(taskId)?.used.tokens ?? 0) <= 0) fail("turn_end metering recorded zero tokens");
		if (requests.some((b) => b.includes(SECRET))) fail("secret from tool_result reached the model");
		if (!requests.some((b) => b.includes("[REDACTED]"))) fail("redacted note.txt never reached the model");
		store.close();
		process.stdout.write(`ok: ${denies} denies + ${allows} allow audited, chain verifies, secret redacted, tokens metered\n`);
	}
	// 2. Over budget: abort after turn 1, exactly one escalation.
	{
		const { store, taskId } = await run("over", 500);
		if (requests.length !== 1) fail(`over-budget run made ${requests.length} model requests, expected 1 (abort)`);
		const open = store.listOpenApprovals("eng@co").filter((a) => a.taskId === taskId);
		if (open.length !== 1) fail(`expected 1 budget escalation, got ${open.length}`);
		store.close();
		process.stdout.write(`ok: over-budget run aborted after 1 model request, escalation "${open[0]?.question}"\n`);
	}
	process.stdout.write("SMOKE PASS: pi-ext held on the real pi host\n");
} finally {
	llm.close();
	rmSync(work, { recursive: true, force: true });
}
