import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlStore, ControlServer, PeerRegistry } from "pi-agentic-control-plane";
import { parseManifest, type Manifest, type Budget } from "pi-agentic-core";
import type { Contract } from "pi-agentic-core";

import { bootstrap, type BootstrapOptions } from "../src/bootstrap.ts";
import { LocalControlClient } from "pi-agentic-control-plane";
import { resolveUnitConfig, ENV_UNIT, ENV_DB, ENV_TASK, ENV_SOCKET, ENV_TOKEN } from "pi-agentic-control-plane";
import { redactSecrets, redactionFound, REDACTION } from "../src/redact.ts";
import { decideToolCall, fileAccess } from "../src/policy-hook.ts";
import { installOrgPolicy } from "../src/org-policy.ts";
import { installOrgContext, renderOrgContext } from "../src/org-context.ts";
import { decideTrust, installOrgTrust } from "../src/org-trust.ts";
import { usageToBudget, handleTurnEnd, installOrgBudget, type BudgetHookState } from "../src/org-budget.ts";
import { nearestRealpath } from "../src/org-policy.ts";
import type { ControlClient } from "pi-agentic-control-plane";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolResultEventResult,
	HookMap,
	RegisterToolSpec,
	ToolCallEvent,
	ToolResultEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartResult,
	TurnEndEvent,
	TurnStartEvent,
} from "../src/pi-api.ts";

const BIG: Budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };

const man = (id: string, path: string, parent: string | null, grants: string[], budget: Budget = BIG): Manifest =>
	parseManifest({ id, path, parent, owner: `${id}@co`, grants, budget });

/**
 * bootstrap() as a dev session (AGENTIC_PI_DEV=1) whose unit.json is synthesized
 * from ORG_UNIT_ID, so tests need no manifest file. Fail-closed behaviour is
 * covered in ext-failclosed.test.ts without this helper.
 */
function devBootstrap(pi: ExtensionAPI, opts: BootstrapOptions) {
	const env: Record<string, string | undefined> = { AGENTIC_PI_DEV: "1", ...opts.env };
	return bootstrap(pi, {
		readManifest: () => JSON.stringify({ id: env[ENV_UNIT], path: env[ENV_UNIT], parent: null, owner: "o@co", grants: [], budget: BIG, trust: ["/d/sales"] }),
		...opts,
		env,
	});
}

const CONTRACT: Contract = {
	schema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string", minLength: 1 } } },
};

/** A fake Pi ExtensionContext recording abort/notify calls. */
function makeCtx() {
	const aborts: number[] = [];
	const notes: string[] = [];
	const ctx: ExtensionContext = {
		ui: { notify: (m: string) => { notes.push(m); } },
		mode: "print",
		hasUI: false,
		cwd: "/",
		abort: () => { aborts.push(1); },
		shutdown: () => {},
		isIdle: () => true,
	};
	return { ctx, aborts, notes };
}

/** A fake ExtensionAPI that records registrations and lets tests fire hooks. */
class FakePi implements ExtensionAPI {
	private readonly handlers = new Map<keyof HookMap, unknown[]>();
	readonly tools = new Map<string, RegisterToolSpec>();
	readonly commands = new Map<string, unknown>();

	readonly ctx = makeCtx();

	on<K extends keyof HookMap>(event: K, handler: HookMap[K]): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => {
			list.splice(list.indexOf(handler), 1);
		};
	}
	registerTool(spec: RegisterToolSpec): void {
		this.tools.set(spec.name, spec);
	}
	registerCommand(name: string, spec: unknown): void {
		this.commands.set(name, spec);
	}

	private list<K extends keyof HookMap>(event: K): HookMap[K][] {
		return (this.handlers.get(event) ?? []) as HookMap[K][];
	}

	async fireToolCall(event: ToolCallEvent) {
		let decision: unknown = { block: false };
		for (const h of this.list("tool_call")) decision = await h(event, this.ctx.ctx);
		return decision;
	}
	/** Returns the last non-empty handler patch, like Pi's runner. */
	async fireToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		let out: ToolResultEventResult | undefined;
		for (const h of this.list("tool_result")) out = (await h(event, this.ctx.ctx)) ?? out;
		return out;
	}
	async fireBeforeAgentStart(event: BeforeAgentStartEvent) {
		let out: BeforeAgentStartResult | undefined;
		for (const h of this.list("before_agent_start")) out = (await h(event, this.ctx.ctx)) ?? out;
		return out;
	}
	async fireTurnStart(event: TurnStartEvent) {
		for (const h of this.list("turn_start")) await h(event, this.ctx.ctx);
	}
	async fireTurnEnd(event: TurnEndEvent) {
		for (const h of this.list("turn_end")) await h(event, this.ctx.ctx);
	}
	async fireProjectTrust(cwd: string) {
		let decision: unknown;
		for (const h of this.list("project_trust")) {
			decision = await h({ cwd }, { cwd, mode: "print", hasUI: false, ui: this.ctx.ctx.ui });
			if ((decision as { trusted?: string } | undefined)?.trusted !== "undecided") break;
		}
		return decision;
	}
	async startSession() {
		for (const h of this.list("session_start")) await h({}, this.ctx.ctx);
	}
}

function makeOrg() {
	const dir = mkdtempSync(join(tmpdir(), "agentic-pi-ext-"));
	const dbPath = join(dir, "control.db");
	let n = 0;
	const store = new ControlStore(dbPath, {
		clock: () => Date.parse("2026-01-01T00:00:00.000Z"),
		genId: (p) => `${p}_${String(++n).padStart(4, "0")}`,
	});
	store.addUnit(man("ceo", "ceo", null, ["tool:read", "delegate:*", "path:rw:/d/**"]));
	store.addUnit(man("sales", "sales", "ceo", ["tool:read", "path:rw:/d/sales/**", "delegate:sales/*"]));
	return {
		dir,
		dbPath,
		store,
		cleanup: () => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

// ---- unit-config --------------------------------------------------------

test("resolveUnitConfig: inert when no env set", () => {
	const r = resolveUnitConfig({});
	assert.ok(r.ok);
	assert.equal(r.config.enabled, false);
});

test("resolveUnitConfig: enabled with unit + db", () => {
	const r = resolveUnitConfig({ [ENV_UNIT]: "sales", [ENV_DB]: "/tmp/c.db", [ENV_TASK]: "task_1" });
	assert.ok(r.ok);
	assert.equal(r.config.enabled, true);
	assert.equal(r.config.unitId, "sales");
	assert.equal(r.config.taskId, "task_1");
});

test("resolveUnitConfig: half-config is an error", () => {
	assert.equal(resolveUnitConfig({ [ENV_UNIT]: "sales" }).ok, false);
	assert.equal(resolveUnitConfig({ [ENV_DB]: "/tmp/c.db" }).ok, false);
});

// ---- redaction (FR9) ----------------------------------------------------

test("redactSecrets masks common secret shapes", () => {
	assert.match(redactSecrets("key sk-ABCDEFGHIJKLMNOPQRSTUV end"), /\[REDACTED\]/);
	assert.match(redactSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), /\[REDACTED\]/);
	assert.equal(redactSecrets("password: hunter2"), `password: ${REDACTION}`);
	assert.equal(redactSecrets("export API_KEY=abcdef12345"), `export API_KEY=${REDACTION}`);
	const url = redactSecrets("postgres://user:s3cr3t@host/db");
	assert.equal(url, "postgres://user:[REDACTED]@host/db");
	assert.match(redactSecrets("Authorization: Bearer abcdef1234567890"), /Bearer \[REDACTED\]/);
});

test("redactSecrets keeps innocent text untouched", () => {
	const s = "the quick brown fox jumps over 123 lazy dogs";
	assert.equal(redactSecrets(s), s);
	assert.equal(redactionFound(s), false);
});

// ---- policy hook (FR2) --------------------------------------------------

test("fileAccess resolves path arg for file tools only", () => {
	const rp = (p: string) => `/real${p}`;
	const base = { cwd: "/w" };
	assert.deepEqual(fileAccess("read", { path: "/d/sales/x" }, rp, base), { path: "/real/d/sales/x", mode: "r" });
	assert.deepEqual(fileAccess("write", { path: "/d/sales/x" }, rp, base), { path: "/real/d/sales/x", mode: "rw" });
	assert.equal(fileAccess("bash", { command: "ls" }, rp, base), null);
});

test("fileAccess fails closed when a file tool has no string path argument", () => {
	const rp = (p: string) => p;
	const base = { cwd: "/w" };
	assert.throws(() => fileAccess("read", { file_path: "/d/sales/x" }, rp, base), /no string 'path'/);
	assert.throws(() => fileAccess("write", {}, rp, base), /no string 'path'/);
	assert.throws(() => fileAccess("edit", { path: 42 }, rp, base), /no string 'path'/);
	assert.throws(() => fileAccess("read", { path: "" }, rp, base), /no string 'path'/);
	assert.throws(() => fileAccess("ls", { path: 7 }, rp, base), /no string 'path'/);
});

test("fileAccess resolves exactly as Pi's tools do (@, ~, file://, unicode spaces, cwd, default '.')", () => {
	const rp = (p: string) => p;
	const base = { cwd: "/srv/org/sales", homeDir: "/home/u" };
	const r = (tool: string, input: Record<string, unknown>) => fileAccess(tool, input, rp, base)?.path;
	assert.equal(r("read", { path: "@/etc/passwd" }), "/etc/passwd");
	assert.equal(r("read", { path: "~/.ssh/id_rsa" }), "/home/u/.ssh/id_rsa");
	assert.equal(r("read", { path: "~" }), "/home/u");
	assert.equal(r("read", { path: "file:///etc/shadow" }), "/etc/shadow");
	assert.equal(r("read", { path: "notes\u00A0x.md" }), "/srv/org/sales/notes x.md");
	assert.equal(r("read", { path: "../eng/secret" }), "/srv/org/eng/secret");
	// grep/find/ls default to the cwd, like Pi's `path || "."`.
	assert.equal(r("ls", {}), "/srv/org/sales");
	assert.equal(r("grep", { pattern: "x", path: "" }), "/srv/org/sales");
	assert.equal(r("find", { pattern: "*.md" }), "/srv/org/sales");
});

test("decideToolCall denies bash without tool:bash grant, allows granted read", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	try {
		const client = new LocalControlClient({ unitId: "sales", taskId: null, store });
		const rp = (p: string) => p;
		// bash: not granted → deny.
		const bash = await decideToolCall({ toolName: "bash", input: { command: "ls" } }, { client, realpath: rp, cwd: "/d/sales" });
		assert.deepEqual(bash, { block: true, reason: "org-policy: tool 'bash' not granted" });
		// read within scope → allow.
		const ok = await decideToolCall({ toolName: "read", input: { path: "/d/sales/report.md" } }, { client, realpath: rp, cwd: "/d/sales" });
		assert.deepEqual(ok, { block: false });
		// write outside scope → deny.
		const outside = await decideToolCall({ toolName: "write", input: { path: "/d/eng/secret" } }, { client, realpath: rp, cwd: "/d/sales" });
		assert.equal(outside?.block, true);
		// "@" prefix must not smuggle an out-of-scope path past the PDP.
		const smuggled = await decideToolCall({ toolName: "read", input: { path: "@/d/eng/secret" } }, { client, realpath: rp, cwd: "/d/sales" });
		assert.equal(smuggled?.block, true);
		void dbPath;
	} finally {
		cleanup();
	}
});

test("decideToolCall canonicalizes a symlinked grant root (no bypass)", async () => {
	mkdirSync(".tmp", { recursive: true });
	const root = realpathSync(mkdtempSync(join(".tmp", "grant-canon-")));
	const dir = mkdtempSync(join(tmpdir(), "agentic-pi-ext-"));
	const store = new ControlStore(join(dir, "control.db"));
	try {
		mkdirSync(join(root, "real"));
		mkdirSync(join(root, "other"));
		symlinkSync(join(root, "real"), join(root, "link"));
		store.addUnit(man("u", "u", null, ["tool:read", `path:rw:${join(root, "link")}/**`]));
		const client = new LocalControlClient({ unitId: "u", taskId: null, store });
		const call = (path: string) => decideToolCall({ toolName: "read", input: { path } }, { client, realpath: nearestRealpath, cwd: root });
		assert.deepEqual(await call(join(root, "link", "f")), { block: false });
		assert.deepEqual(await call(join(root, "real", "f")), { block: false });
		assert.equal((await call(join(root, "other", "f")))?.block, true);
		assert.equal((await call(join(root, "link", "..", "other", "f")))?.block, true);
		const boom = (p: string): string => {
			if (p === join(root, "link")) throw new Error("resolver exploded");
			return p;
		};
		const t = await decideToolCall({ toolName: "read", input: { path: join(root, "real", "f") } }, { client, realpath: boom, cwd: root });
		assert.equal(t?.block, true);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("org tools are free (never blocked by policy)", async () => {
	const { store, cleanup } = makeOrg();
	try {
		const client = new LocalControlClient({ unitId: "sales", taskId: null, store });
		const d = await decideToolCall({ toolName: "org_delegate", input: {} }, { client, realpath: (p) => p, cwd: "/d/sales" });
		assert.deepEqual(d, { block: false });
	} finally {
		cleanup();
	}
});

test("installOrgPolicy wires tool_call deny and tool_result redaction", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		installOrgPolicy(pi, runtime, (p) => p);
		await pi.startSession();

		const denied = await pi.fireToolCall({ toolName: "bash", input: { command: "rm -rf /" } });
		assert.equal((denied as { block: boolean }).block, true);

		const result: ToolResultEvent = { toolName: "read", content: [{ type: "text", text: "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" }] };
		const patch = await pi.fireToolResult(result);
		assert.match((patch?.content?.[0] as { text: string }).text, /\[REDACTED\]/);
	} finally {
		cleanup();
	}
});

test("tool_result returns redacted content AND structuredContent; nothing when unchanged", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		installOrgPolicy(pi, runtime, (p) => p);
		await pi.startSession();
		const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
		const patch = await pi.fireToolResult({
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			structuredContent: { rows: [{ note: `token: ${secret}` }, 7, null], nested: { deep: [secret] }, clean: "fine" },
		});
		assert.ok(patch?.structuredContent, "structuredContent is returned");
		const json = JSON.stringify(patch);
		assert.ok(!json.includes(secret), json);
		assert.match(json, /\[REDACTED\]/);
		assert.deepEqual((patch!.structuredContent as { clean: string }).clean, "fine");
		assert.equal((patch!.structuredContent as { rows: unknown[] }).rows[1], 7);

		const none = await pi.fireToolResult({ toolName: "read", content: [{ type: "text", text: "hello" }], structuredContent: { a: "b" } });
		assert.equal(none, undefined);
	} finally {
		cleanup();
	}
});

test("tool_call blocks file tool with unexpected path field and when decide throws", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		installOrgPolicy(pi, runtime, (p) => p);
		await pi.startSession();
		const bad = (await pi.fireToolCall({ toolName: "read", input: { file_path: "/d/sales/x" } })) as { block: boolean; reason: string };
		assert.equal(bad.block, true);
		assert.match(bad.reason, /no string 'path'/);

		const real = runtime.client!;
		runtime.client = Object.assign(Object.create(real) as ControlClient, {
			effectiveGrants: () => {
				throw new Error("pdp exploded");
			},
		});
		const thrown = (await pi.fireToolCall({ toolName: "read", input: { path: "/d/sales/x" } })) as { block: boolean; reason: string };
		assert.equal(thrown.block, true);
		assert.match(thrown.reason, /pdp exploded/);
	} finally {
		cleanup();
	}
});

test("every PDP decision is audited; audit failure blocks (fail closed)", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		installOrgPolicy(pi, runtime, (p) => p);
		await pi.startSession();
		const real = runtime.client!;
		const recorded: Array<{ toolName: string; allow: boolean }> = [];
		runtime.client = Object.assign(Object.create(real) as ControlClient, {
			recordDecision: async (req: { toolName: string }, d: { allow: boolean }) => {
				recorded.push({ toolName: req.toolName, allow: d.allow });
			},
		});
		assert.deepEqual(await pi.fireToolCall({ toolName: "read", input: { path: "/d/sales/a" } }), { block: false });
		assert.equal(((await pi.fireToolCall({ toolName: "bash", input: { command: "ls" } })) as { block: boolean }).block, true);
		assert.deepEqual(await pi.fireToolCall({ toolName: "org_complete", input: {} }), { block: false });
		assert.equal(((await pi.fireToolCall({ toolName: "org_status", input: {} })) as { block: boolean }).block, true, "org_status is not a registered tool, so it is not free");
		assert.deepEqual(recorded, [
			{ toolName: "read", allow: true },
			{ toolName: "bash", allow: false },
			{ toolName: "org_status", allow: false },
		]);

		runtime.client = Object.assign(Object.create(real) as ControlClient, {
			recordDecision: async () => {
				throw new Error("audit down");
			},
		});
		const r = (await pi.fireToolCall({ toolName: "read", input: { path: "/d/sales/a" } })) as { block: boolean; reason: string };
		assert.equal(r.block, true);
		assert.match(r.reason, /audit failed \(audit down\)/);
	} finally {
		cleanup();
	}
});

test("nearestRealpath keeps the full top-level component of a non-existent path", () => {
	const name = `agentic-pi-nonexistent-${process.pid}`;
	assert.equal(nearestRealpath(`/${name}`), `/${name}`);
	assert.equal(nearestRealpath(`/${name}/sub/file.txt`), `/${name}/sub/file.txt`);
});

// ---- org-delegate tools (FR3/FR4/FR5) -----------------------------------

test("org_delegate tool delegates through the control plane", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "ceo", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "ceo", taskId: null, store }),
		});
		const { installOrgDelegate } = await import("../src/org-delegate.ts");
		installOrgDelegate(pi, runtime);
		await pi.startSession();

		const tool = pi.tools.get("org_delegate");
		assert.ok(tool);
		const res = await tool.execute("c1", {
			toUnit: "sales",
			goal: "sell widgets",
			contract: CONTRACT,
			grants: ["tool:read", "path:rw:/d/sales/q3/**"],
			budget: { tokens: 500, costUsd: 1, wallClockSec: 60 },
		}, undefined, undefined, pi.ctx.ctx);
		assert.equal(res.isError ?? false, false);
		assert.match((res.content[0] as { text: string }).text, /delegated task .* to sales/);
		// A pending task now exists for sales.
		const open = store.listUnits().find((u) => u.id === "sales");
		assert.ok(open);
	} finally {
		cleanup();
	}
});

test("org_delegate tool reports a denial", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		const { installOrgDelegate } = await import("../src/org-delegate.ts");
		installOrgDelegate(pi, runtime);
		await pi.startSession();
		const tool = pi.tools.get("org_delegate")!;
		// sales delegating to ceo (its ancestor) is not authorized.
		const res = await tool.execute("c1", {
			toUnit: "ceo",
			goal: "x",
			contract: CONTRACT,
			budget: { tokens: 10, costUsd: 0, wallClockSec: 1 },
		}, undefined, undefined, pi.ctx.ctx);
		assert.equal(res.isError, true);
		assert.match((res.content[0] as { text: string }).text, /denied/);
	} finally {
		cleanup();
	}
});

// ---- org-context --------------------------------------------------------

test("renderOrgContext lists identity, grants and budget", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		installOrgContext(pi, runtime);
		await pi.startSession();
		const text = renderOrgContext(runtime);
		assert.match(text, /unit \*\*sales\*\*/);
		assert.match(text, /path:rw:\/d\/sales/);
		assert.match(text, /Remaining budget/);

		const event: BeforeAgentStartEvent = { systemPromptOptions: { sections: {} } };
		await pi.fireBeforeAgentStart(event);
		assert.ok(event.systemPromptOptions.sections.org_context);
	} finally {
		cleanup();
	}
});

// ---- org-trust ----------------------------------------------------------

test("decideTrust trusts only manifest-listed dirs, never merely granted paths", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		await pi.startSession();
		const rp = (p: string) => p;
		assert.deepEqual(decideTrust(runtime, "/d/sales", rp), { trusted: "yes" });
		assert.deepEqual(decideTrust(runtime, "/d/sales/emea", rp), { trusted: "yes" });
		assert.deepEqual(decideTrust(runtime, "/d/eng", rp), { trusted: "no" });
	} finally {
		cleanup();
	}
});

test("decideTrust: a path grant without a manifest `trust` entry is NOT trusted (.31)", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			readManifest: () => JSON.stringify({ id: "sales", path: "sales", parent: null, owner: "o@co", grants: ["path:rw:/d/sales/**"], budget: BIG }),
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		await pi.startSession();
		assert.ok(runtime.client?.effectiveGrants().some((g) => g.kind === "path" && g.pattern === "/d/sales/**"), "the unit does hold the path grant");
		assert.deepEqual(decideTrust(runtime, "/d/sales", (p) => p), { trusted: "no" });
	} finally {
		cleanup();
	}
});

// ---- socket transport + project_trust ordering (ADR-0003) ----------------

test("project_trust fired BEFORE session_start connects and trusts only granted paths", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		installOrgTrust(pi, runtime, (p) => p);
		assert.equal(runtime.client, null, "no client before any hook fires");
		assert.deepEqual(await pi.fireProjectTrust("/d/sales/emea"), { trusted: "yes" });
		assert.ok(runtime.client, "project_trust connected the client");
		assert.deepEqual(await pi.fireProjectTrust("/d/eng"), { trusted: "no" });
		await pi.startSession(); // idempotent: reuses the same client
	} finally {
		cleanup();
	}
});

test("project_trust distrusts when the control plane cannot be reached", async () => {
	const pi = new FakePi();
	const runtime = devBootstrap(pi, {
		env: { [ENV_UNIT]: "sales", [ENV_DB]: "unused.db" },
		openClient: () => {
			throw new Error("connect refused");
		},
	});
	installOrgTrust(pi, runtime, (p) => p);
	assert.deepEqual(await pi.fireProjectTrust("/d/sales"), { trusted: "no" });
	assert.equal(runtime.client, null);
});

/** Real ControlServer on a short unix socket under ./.tmp (macOS caps socket paths near 104 bytes). */
async function makeSocketOrg() {
	const { dir: _d, store, cleanup: baseCleanup } = makeOrg();
	const tmpRoot = join(import.meta.dirname, "../../../.tmp");
	mkdirSync(tmpRoot, { recursive: true });
	const sockDir = mkdtempSync(join(tmpRoot, "s-"));
	const socketPath = join(realpathSync(sockDir), "c.sock");
	const reg = new PeerRegistry();
	const token = reg.issueToken("sales");
	const server = new ControlServer({ store, auth: reg });
	await server.listen(socketPath);
	const absent = join(sockDir, "must-not-exist.db");
	return {
		store,
		token,
		socketPath,
		absent,
		server,
		cleanup: async () => {
			await server.close().catch(() => {});
			baseCleanup();
			rmSync(sockDir, { recursive: true, force: true });
		},
	};
}

test("bootstrap over ORG_CONTROL_SOCKET: audited via the server, worker never opens control.db", async () => {
	const { store, token, socketPath, absent, cleanup } = await makeSocketOrg();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: absent, [ENV_SOCKET]: socketPath, [ENV_TOKEN]: token },
		});
		installOrgPolicy(pi, runtime, (p) => p);
		installOrgTrust(pi, runtime, (p) => p);
		assert.deepEqual(await pi.fireProjectTrust("/d/sales"), { trusted: "yes" }); // before session_start
		await pi.startSession();
		assert.deepEqual(await pi.fireToolCall({ toolName: "read", input: { path: "/d/sales/a.txt" } }), { block: false });
		const denied = (await pi.fireToolCall({ toolName: "bash", input: { command: "ls" } })) as { block: boolean };
		assert.equal(denied.block, true);
		const rows = store.auditEntries().filter((e) => e.actor === "policy:sales");
		assert.deepEqual(rows.map((e) => e.action), ["tool.allow", "tool.deny"]);
		assert.ok(store.verifyAudit().ok);
		assert.equal(existsSync(absent), false, "worker must not create/open control.db");
		await runtime.client?.close();
	} finally {
		await cleanup();
	}
});

test("turn_start refresh failure drops the client and the next tool_call is blocked", async () => {
	const { socketPath, token, absent, server, cleanup } = await makeSocketOrg();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: absent, [ENV_SOCKET]: socketPath, [ENV_TOKEN]: token },
		});
		installOrgPolicy(pi, runtime, (p) => p);
		await pi.startSession();
		assert.deepEqual(await pi.fireToolCall({ toolName: "read", input: { path: "/d/sales/a.txt" } }), { block: false });
		await server.close();
		await assert.rejects(pi.fireTurnStart({ turnIndex: 0 } as TurnStartEvent));
		assert.equal(runtime.client, null);
		const r = (await pi.fireToolCall({ toolName: "read", input: { path: "/d/sales/a.txt" } })) as { block: boolean };
		assert.equal(r.block, true);
	} finally {
		await cleanup();
	}
});

// ---- org-budget (FR6) ---------------------------------------------------

const assistant = (usage: object): TurnEndEvent => ({ turnIndex: 0, message: { role: "assistant", usage } });

test("usageToBudget reads Pi usage: totalTokens or component sum, cost.total, sanitizes junk", () => {
	assert.deepEqual(usageToBudget({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.2 } }), { tokens: 20, costUsd: 0.2, wallClockSec: 0 });
	assert.deepEqual(usageToBudget({ totalTokens: 42, input: 1 }), { tokens: 42, costUsd: 0, wallClockSec: 0 });
	assert.deepEqual(usageToBudget(undefined, 2.5), { tokens: 0, costUsd: 0, wallClockSec: 2.5 });
	assert.deepEqual(usageToBudget({ totalTokens: Number.NaN, input: -5, output: Infinity, cost: { total: -1 } }), { tokens: 0, costUsd: 0, wallClockSec: 0 });
});

function budgetFixture() {
	const org = makeOrg();
	const del = org.store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "g", contract: CONTRACT, budget: { tokens: 1000, costUsd: 100, wallClockSec: 100 } });
	assert.ok(del.ok);
	org.store.startTask(del.taskId);
	return { ...org, taskId: del.taskId };
}

test("turn_end meters message.usage (non-zero) and wall-clock from turn_start", async () => {
	const { store, dbPath, taskId, cleanup } = budgetFixture();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath, [ENV_TASK]: taskId },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId, store }),
		});
		let now = 0;
		installOrgBudget(pi, runtime, () => now);
		await pi.startSession();

		await pi.fireTurnStart({ turnIndex: 0, timestamp: 1_000 });
		now = 4_000;
		await pi.fireTurnEnd(assistant({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: 0.5 } }));
		const used = store.getTask(taskId)!.used;
		assert.equal(used.tokens, 150);
		assert.equal(used.costUsd, 0.5);
		assert.equal(used.wallClockSec, 3);
		assert.deepEqual(pi.ctx.aborts, []);

		// Non-assistant messages carry no usage: nothing metered.
		await pi.fireTurnEnd({ turnIndex: 1, message: { role: "toolResult", usage: { totalTokens: 999 } } });
		assert.equal(store.getTask(taskId)!.used.tokens, 150);
	} finally {
		cleanup();
	}
});

test("over budget calls ctx.abort exactly once and notifies with the escalation", async () => {
	const { store, dbPath, taskId, cleanup } = budgetFixture();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath, [ENV_TASK]: taskId },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId, store }),
		});
		installOrgBudget(pi, runtime, () => 0);
		await pi.startSession();

		await pi.fireTurnEnd(assistant({ totalTokens: 5000 })); // task budget is 1000 tokens
		assert.equal(pi.ctx.aborts.length, 1);
		assert.match(pi.ctx.notes.join("\n"), /over budget on tokens/);
		await pi.fireTurnEnd(assistant({ totalTokens: 10 }));
		assert.equal(pi.ctx.aborts.length, 1, "abort is not repeated");
	} finally {
		cleanup();
	}
});

test("handleTurnEnd aborts (fail closed) when metering itself throws", async () => {
	const { store, dbPath, taskId, cleanup } = budgetFixture();
	const pi = new FakePi();
	try {
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath, [ENV_TASK]: taskId },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId, store }),
		});
		await pi.startSession();
		const real = runtime.client!;
		runtime.client = Object.assign(Object.create(real) as ControlClient, {
			meter: async () => {
				throw new Error("db locked");
			},
		});
		const { ctx, aborts, notes } = makeCtx();
		const state: BudgetHookState = { tripped: false, turnStartMs: null };
		await handleTurnEnd(runtime, assistant({ totalTokens: 1 }), ctx, state, 0);
		await handleTurnEnd(runtime, assistant({ totalTokens: 1 }), ctx, state, 0);
		assert.equal(aborts.length, 1);
		assert.match(notes[0]!, /metering failed \(db locked\)/);
	} finally {
		cleanup();
	}
});

// ---- org-approvals (/approvals command, ADR-0007) -----------------------

test("/approvals command lists and resolves owner-scoped approvals", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		// sales has a task escalated to its owner (sales@co).
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: { tokens: 10, costUsd: 1, wallClockSec: 1 } });
		assert.ok(d.ok);
		const appr = store.escalate(d.ok ? d.taskId : "", "ship?", ["yes", "no"]);

		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		const { installOrgApprovals } = await import("../src/org-approvals.ts");
		installOrgApprovals(pi, runtime);
		await pi.startSession();

		const cmd = pi.commands.get("approvals") as { handler: (args: string, ctx: unknown) => Promise<void> };
		assert.ok(cmd);
		const notes: string[] = [];
		const ctx = { ui: { notify: (m: string) => { notes.push(m); } } };

		await cmd.handler("list", ctx);
		assert.ok(notes.some((n) => n.includes(appr.id)), "list shows the owner's approval");

		notes.length = 0;
		await cmd.handler(`approve ${appr.id} yes`, ctx);
		assert.ok(notes.some((n) => /approved/.test(n)));
		assert.equal(store.getApproval(appr.id)?.status, "approved");
		// approving re-opens the task as pending.
		assert.equal(store.getTask(d.ok ? d.taskId : "")?.status, "pending");
	} finally {
		cleanup();
	}
});

test("/approvals list shows nothing for a non-owning unit", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "x", contract: CONTRACT, budget: { tokens: 10, costUsd: 1, wallClockSec: 1 } });
		assert.ok(d.ok);
		store.escalate(d.ok ? d.taskId : "", "ship?", ["yes", "no"]); // owner sales@co

		// ceo opens its own inbox — the approval is owned by sales@co, not ceo@co.
		const runtime = devBootstrap(pi, {
			env: { [ENV_UNIT]: "ceo", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "ceo", taskId: null, store }),
		});
		const { installOrgApprovals } = await import("../src/org-approvals.ts");
		installOrgApprovals(pi, runtime);
		await pi.startSession();

		const cmd = pi.commands.get("approvals") as { handler: (args: string, ctx: unknown) => Promise<void> };
		const notes: string[] = [];
		await cmd.handler("list", { ui: { notify: (m: string) => { notes.push(m); } } });
		assert.deepEqual(notes, ["no open approvals"]);
	} finally {
		cleanup();
	}
});

test("decideToolCall gates MCP tools and resource tools on mcp: grants", async () => {
	const { parseGrants } = await import("pi-agentic-core");
	const mk = (grants: string[]) => {
		const parsed = parseGrants(grants);
		return { effectiveGrants: () => parsed, recordDecision: async () => {} } as unknown as LocalControlClient;
	};
	const run = (grants: string[], toolName: string, input: Record<string, unknown> = {}) =>
		decideToolCall({ toolName, input }, { client: mk(grants), realpath: (p) => p, cwd: "/d/sales" });
	assert.equal((await run(["tool:*"], "mcp__crm__lookup"))?.block, true);
	assert.equal((await run(["tool:*", "mcp:crm"], "mcp__crm__lookup"))?.block, false);
	assert.equal((await run(["tool:*", "mcp:crm"], "mcp__erp__lookup"))?.block, true);
	assert.equal((await run(["tool:*", "mcp:*"], "mcp__nonsense"))?.block, true);
	// resource tools take the server from their argument
	assert.equal((await run(["tool:*", "mcp:crm"], "read_mcp_resource", { server: "crm", uri: "x://y" }))?.block, false);
	assert.equal((await run(["tool:*", "mcp:crm"], "read_mcp_resource", { server: "erp", uri: "x://y" }))?.block, true);
	assert.equal((await run(["tool:*", "mcp:crm"], "read_mcp_resource", { uri: "x://y" }))?.block, true);
	assert.equal((await run(["tool:*", "mcp:crm"], "list_mcp_resources", { server: "crm" }))?.block, false);
	// listing every server needs mcp:*
	assert.equal((await run(["tool:*", "mcp:crm"], "list_mcp_resources"))?.block, true);
	assert.equal((await run(["tool:*", "mcp:*"], "list_mcp_resources"))?.block, false);
	assert.equal((await run(["tool:*", "mcp:crm"], "list_mcp_resources", { server: 5 }))?.block, true);
});
