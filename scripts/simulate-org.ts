/**
 * Simulate a full org deployment on this machine, entirely under ./.tmp:
 *
 *   org repo tree (ceo, eng; unit.json + AGENTS.md)  ->  control.db seeded from the manifests
 *   ControlServer on a unix socket (dev tokens)      ->  Dispatcher (spawn mode)
 *   per-unit agent dir whose settings.json pins the org package, installed with the
 *   real `pi install <local path>` (personal scope, so org-trust joins project_trust)
 *   real headless `pi --mode json -p` worker, cwd = unit workspace, NO `-e`
 *   scripted OpenAI-compatible fake model: read in-scope, denied out-of-scope, org_complete.
 *
 *   npm run simulate:org [-- --keep]
 *
 * Exits non-zero on any failed assertion. Needs `pi` on PATH and a built workspace
 * (`npm run build`; the package manifest points at dist/). No model keys needed.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ControlServer, ControlStore, Dispatcher, PeerRegistry, type WorkerSpec } from "pi-agentic-control-plane";
import { parseManifest } from "pi-agentic-core";

const keep = process.argv.includes("--keep");
const repo = resolve(import.meta.dirname, "..");
const extensionPkg = join(repo, "packages/extension");
const fail = (msg: string): never => {
	throw new Error(`simulate-org FAIL: ${msg}`);
};
const checks: string[] = [];
const check = (cond: unknown, msg: string): void => {
	if (!cond) fail(msg);
	checks.push(msg);
};

if (!existsSync(join(extensionPkg, "dist/index.js"))) fail("packages/extension/dist is missing; run `npm run build` first");

mkdirSync(join(repo, ".tmp"), { recursive: true });
const sim = mkdtempSync(join(repo, ".tmp", "sim-"));
const orgRoot = join(sim, "org");
const stateDir = join(sim, "state");
mkdirSync(stateDir, { recursive: true });

// ---- 1. org repo tree: one dir per unit with unit.json + AGENTS.md ---------------------------------
const budget = { tokens: 1_000_000, costUsd: 100, wallClockSec: 100_000 };
const wsOf = (path: string): string => join(orgRoot, path);
for (const id of ["ceo", "eng"]) mkdirSync(wsOf(id), { recursive: true });
// Grants are matched against realpaths (macOS /var -> /private/var etc.), so grant the canonical path.
const engWs = realpathSync(wsOf("eng"));
const ceoWs = realpathSync(wsOf("ceo"));
const manifests = [
	{ id: "ceo", path: "ceo", parent: null, owner: "ceo@co", grants: ["tool:read", "delegate:*", `path:rw:${ceoWs}/**`], budget, trust: [ceoWs] },
	{ id: "eng", path: "eng", parent: "ceo", owner: "eng@co", grants: ["tool:read", `path:rw:${engWs}/**`], budget, trust: [engWs] },
];
// SPEC §5 / bead .31: the manifest lives OUTSIDE every unit-writable path (deploy: /etc/agentic-pi/units/<id>/unit.json),
// and project trust comes only from the manifest's `trust` list, never from path grants.
const manifestDir = join(sim, "manifests");
const manifestDirOf = (id: string): string => join(manifestDir, id);
for (const m of manifests) {
	mkdirSync(manifestDirOf(m.id), { recursive: true });
	writeFileSync(join(manifestDirOf(m.id), "unit.json"), `${JSON.stringify(m, null, 2)}\n`);
	writeFileSync(join(wsOf(m.path), "AGENTS.md"), `# ${m.id}\n\nYou are the ${m.id} unit. Finish by calling org_complete.\n`);
}
writeFileSync(join(engWs, "spec.txt"), "build the thing\n");
const outsideFile = join(orgRoot, "outside-secret.txt"); // inside the org repo but granted to nobody
writeFileSync(outsideFile, "must never be read by eng\n");
// A project-scoped extension: Pi loads it only once the project is trusted. It proves trust
// came from org-trust (default trust is "ask", which headless Pi treats as untrusted).
const trustMarker = join(sim, "project-trusted.marker");
mkdirSync(join(engWs, ".pi/extensions"), { recursive: true });
writeFileSync(
	join(engWs, ".pi/extensions/trust-marker.ts"),
	`import { writeFileSync } from "node:fs";\nexport default function () {\n\twriteFileSync(${JSON.stringify(trustMarker)}, "trusted\\n");\n}\n`,
);

// ---- 2. control plane: db seeded from manifests, socket server, dev tokens ----------------------
const dbPath = join(stateDir, "control.db");
const store = new ControlStore(dbPath, {});
for (const m of manifests) {
	const raw = JSON.parse(readFileSync(join(manifestDirOf(m.id), "unit.json"), "utf8"));
	store.addUnit(parseManifest(raw));
}
const peers = new PeerRegistry();
const tokens = new Map(manifests.map((m) => [m.id, peers.issueToken(m.id)]));
const socketPath = join(sim, "c.sock");
if (Buffer.byteLength(socketPath) >= 100) fail(`socket path too long for sun_path: ${socketPath}`);
const server = new ControlServer({ store, auth: peers });
await server.listen(socketPath);

// ---- 3. per-unit agent dir: org package installed with the real `pi install` -------------------------
const fakePort = Promise.withResolvers<number>();
const seenToolNames: string[] = [];
const llm = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const parsed = JSON.parse(body) as { messages: Array<{ role: string }> };
		const step = parsed.messages.filter((m) => m.role === "tool").length;
		const base = { id: `c${step}`, object: "chat.completion.chunk", created: 0, model: "fake" };
		const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const call = (name: string, args: unknown) => {
			seenToolNames.push(name);
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
		};
		if (step === 0) call("read", { path: "spec.txt" }); // in scope: allowed
		else if (step === 1) call("read", { path: outsideFile }); // out of scope: denied
		else if (step === 2) call("org_complete", { artifact: { summary: "built the thing", files: ["spec.txt"] } });
		else {
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		}
		send({ ...base, choices: [], usage: { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 } });
		res.end("data: [DONE]\n\n");
	});
});
llm.listen(0, "127.0.0.1", () => {
	const a = llm.address();
	if (a === null || typeof a === "string") fakePort.reject(new Error("fake model has no TCP port"));
	else fakePort.resolve(a.port);
});
const port = await fakePort.promise;

const agentDirOf = (unitId: string): string => join(sim, "units", unitId, "agent-dir");
function provisionAgentDir(unitId: string): string {
	const dir = agentDirOf(unitId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "fake-model" }] } } }),
	);
	const r = spawnSync("pi", ["install", extensionPkg], { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: "utf8" });
	if (r.status !== 0) fail(`pi install failed (${r.status}): ${r.stderr}${r.stdout}`);
	return dir;
}
const engAgentDir = provisionAgentDir("eng");
const settings = JSON.parse(readFileSync(join(engAgentDir, "settings.json"), "utf8")) as { packages?: unknown[]; defaultProjectTrust?: string };
check(Array.isArray(settings.packages) && settings.packages.length === 1, "agent-dir settings.json pins exactly the org package");
check(settings.defaultProjectTrust === undefined || settings.defaultProjectTrust === "ask", "defaultProjectTrust is not widened (stays ask)");
const listed = spawnSync("pi", ["list"], { env: { ...process.env, PI_CODING_AGENT_DIR: engAgentDir }, encoding: "utf8" });
check(listed.status === 0 && listed.stdout.includes(extensionPkg), "`pi list` shows the installed org package");

// ---- 4. delegate ceo -> eng, run through the real Dispatcher in spawn mode ----------------------------
const contract = {
	schema: { type: "object", required: ["summary", "files"], properties: { summary: { type: "string", minLength: 1 }, files: { type: "array", items: { type: "string" }, minItems: 1 } }, additionalProperties: false },
};
const d = store.delegate({ fromUnit: "ceo", toUnit: "eng", goal: "Read spec.txt and report a summary", contract, budget: { tokens: 100_000, costUsd: 10, wallClockSec: 3600 } });
if (!d.ok) fail(`delegate rejected: ${d.reason}`);
const taskId = d.ok ? d.taskId : "";

// The worker must never open control.db: ORG_CONTROL_DB points at a path nothing may create.
const forbiddenDb = join(sim, "worker-must-not-open.db");
const exits: Array<Promise<{ code: number | null; stdout: string; stderr: string }>> = [];
const spawner = (spec: WorkerSpec): void => {
	const dir = provisionedDirs.get(spec.unit.id);
	if (!dir) fail(`no agent dir provisioned for ${spec.unit.id}`);
	const child: ChildProcess = spawn(
		"pi",
		["-p", "--mode", "json", "--model", "fake/fake-model", `Task ${spec.task.id}: ${spec.task.goal}`],
		{
			cwd: spec.cwd,
			timeout: 90_000,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...spec.env, PI_CODING_AGENT_DIR: dir, ORG_CONTROL_DB: forbiddenDb },
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (c) => (stdout += c));
	child.stderr?.on("data", (c) => (stderr += c));
	const done = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
	child.on("error", done.reject);
	child.on("close", (code) => done.resolve({ code, stdout, stderr }));
	exits.push(done.promise);
};
const provisionedDirs = new Map([["eng", engAgentDir]]);
const dispatcher = new Dispatcher({
	store,
	socketPath,
	workspaceOf: (u) => wsOf(u.path),
	tokenOf: (id) => tokens.get(id),
	manifestDirOf,
	spawner,
});

let outcome = "";
try {
	const dispatched = await dispatcher.tick();
	check(dispatched.length === 1 && dispatched[0] === taskId, "dispatcher spawned exactly the delegated eng task");
	const [exit] = await Promise.all(exits);
	if (!exit) throw new Error("simulate-org FAIL: no worker was spawned");
	if (exit.code !== 0) fail(`pi worker exited ${exit.code}\nstderr: ${exit.stderr}\nstdout tail: ${exit.stdout.slice(-2000)}`);
	check(!existsSync(forbiddenDb), "worker never opened control.db (ORG_CONTROL_DB path does not exist)");
	check(seenToolNames.join(",") === "read,read,org_complete", `fake model saw tool turns read,read,org_complete (got ${seenToolNames.join(",")})`);
	check(existsSync(trustMarker), "project-scoped extension loaded: project trusted via org-trust (default trust is ask)");

	// ---- 5. assertions on the authoritative state --------------------------------------------------
	const task = store.getTask(taskId);
	check(task?.status === "done", `task ${taskId} is done (status ${task?.status}, reason ${task?.reason})`);
	const artifact = task?.artifactHash ? store.getArtifact(task.artifactHash) : undefined;
	check(isDeepStrictEqual(artifact, { summary: "built the thing", files: ["spec.txt"] }), "artifact stored under its hash and matches what the model submitted");
	const policy = store.auditEntries().filter((e) => e.actor === "policy:eng");
	const denies = policy.filter((e) => e.action === "tool.deny");
	const allows = policy.filter((e) => e.action === "tool.allow");
	check(denies.length === 1 && JSON.stringify(denies[0]?.data).includes("outside-secret.txt"), "out-of-scope read denied and audited");
	check(allows.length >= 1, `in-scope tool calls allowed and audited (${allows.length} allow rows)`);
	check(store.auditEntries().some((e) => e.action === "complete" && e.subject === taskId), "completion through the contract gate is audited");
	check(store.verifyAudit().ok, "audit chain verifies");
	check((task?.used.tokens ?? 0) > 0 || (store.getUnit("eng")?.used.tokens ?? 0) > 0, "turn metering recorded token usage");
	outcome = `PASS simulate-org: ${checks.length} checks\n${checks.map((c) => `  ok  ${c}`).join("\n")}`;
} finally {
	await server.close();
	llm.close();
	store.close();
	if (keep) process.stdout.write(`kept ${sim}\n`);
	else rmSync(sim, { recursive: true, force: true });
}
process.stdout.write(`${outcome}\n`);
