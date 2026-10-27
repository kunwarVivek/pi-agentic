import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlStore } from "../src/store/control.ts";
import { parseManifest, type Manifest, type Budget } from "../src/core/manifest.ts";
import type { Contract } from "../src/core/gates.ts";

import { bootstrap } from "../src/ext/bootstrap.ts";
import { LocalControlClient } from "../src/ext/control-client.ts";
import { resolveUnitConfig, ENV_UNIT, ENV_DB, ENV_TASK } from "../src/ext/unit-config.ts";
import { redactSecrets, redactionFound, REDACTION } from "../src/ext/redact.ts";
import { decideToolCall, fileAccess } from "../src/ext/policy-hook.ts";
import { installOrgPolicy } from "../src/ext/org-policy.ts";
import { installOrgContext, renderOrgContext } from "../src/ext/org-context.ts";
import { decideTrust } from "../src/ext/org-trust.ts";
import { usageToBudget, handleTurnEnd, type BudgetHookState } from "../src/ext/org-budget.ts";
import type {
	ExtensionAPI,
	HookMap,
	RegisterToolSpec,
	ToolCallEvent,
	ToolResultEvent,
	BeforeAgentStartEvent,
	TurnEndEvent,
} from "../src/ext/pi-api.ts";

const BIG: Budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };

const man = (id: string, path: string, parent: string | null, grants: string[], budget: Budget = BIG): Manifest =>
	parseManifest({ id, path, parent, owner: `${id}@co`, grants, budget });

const CONTRACT: Contract = {
	schema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string", minLength: 1 } } },
};

/** A fake ExtensionAPI that records registrations and lets tests fire hooks. */
class FakePi implements ExtensionAPI {
	private readonly handlers = new Map<keyof HookMap, unknown[]>();
	readonly tools = new Map<string, RegisterToolSpec>();
	readonly commands = new Map<string, unknown>();

	on<K extends keyof HookMap>(event: K, handler: HookMap[K]): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
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
		for (const h of this.list("tool_call")) decision = await h(event);
		return decision;
	}
	async fireToolResult(event: ToolResultEvent) {
		for (const h of this.list("tool_result")) await h(event);
	}
	async fireBeforeAgentStart(event: BeforeAgentStartEvent) {
		for (const h of this.list("before_agent_start")) await h(event);
	}
	async fireTurnEnd(event: TurnEndEvent) {
		for (const h of this.list("turn_end")) await h(event);
	}
	async startSession() {
		for (const h of this.list("session_start")) await h({});
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
	assert.deepEqual(fileAccess("read", { path: "/d/sales/x" }, rp), { path: "/real/d/sales/x", mode: "r" });
	assert.deepEqual(fileAccess("write", { path: "/d/sales/x" }, rp), { path: "/real/d/sales/x", mode: "rw" });
	assert.equal(fileAccess("bash", { command: "ls" }, rp), null);
});

test("decideToolCall denies bash without tool:bash grant, allows granted read", () => {
	const { store, dbPath, cleanup } = makeOrg();
	try {
		const client = new LocalControlClient({ unitId: "sales", taskId: null, store });
		const rp = (p: string) => p;
		// bash: not granted → deny.
		const bash = decideToolCall({ toolName: "bash", input: { command: "ls" } }, { client, realpath: rp });
		assert.deepEqual(bash, { block: true, reason: "org-policy: tool 'bash' not granted" });
		// read within scope → allow.
		const ok = decideToolCall({ toolName: "read", input: { path: "/d/sales/report.md" } }, { client, realpath: rp });
		assert.deepEqual(ok, { block: false });
		// write outside scope → deny.
		const outside = decideToolCall({ toolName: "write", input: { path: "/d/eng/secret" } }, { client, realpath: rp });
		assert.equal((outside as { block: boolean }).block, true);
		void dbPath;
	} finally {
		cleanup();
	}
});

test("org tools are free (never blocked by policy)", () => {
	const { store, cleanup } = makeOrg();
	try {
		const client = new LocalControlClient({ unitId: "sales", taskId: null, store });
		const d = decideToolCall({ toolName: "org_delegate", input: {} }, { client, realpath: (p) => p });
		assert.deepEqual(d, { block: false });
	} finally {
		cleanup();
	}
});

test("installOrgPolicy wires tool_call deny and tool_result redaction", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = bootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		installOrgPolicy(pi, runtime, (p) => p);
		await pi.startSession();

		const denied = await pi.fireToolCall({ toolName: "bash", input: { command: "rm -rf /" } });
		assert.equal((denied as { block: boolean }).block, true);

		const result: ToolResultEvent = { toolName: "read", content: [{ type: "text", text: "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" }] };
		await pi.fireToolResult(result);
		assert.match(result.content[0]!.text, /\[REDACTED\]/);
	} finally {
		cleanup();
	}
});

// ---- org-delegate tools (FR3/FR4/FR5) -----------------------------------

test("org_delegate tool delegates through the control plane", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = bootstrap(pi, {
			env: { [ENV_UNIT]: "ceo", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "ceo", taskId: null, store }),
		});
		const { installOrgDelegate } = await import("../src/ext/org-delegate.ts");
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
		});
		assert.equal(res.isError ?? false, false);
		assert.match(res.content[0]!.text, /delegated task .* to sales/);
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
		const runtime = bootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		const { installOrgDelegate } = await import("../src/ext/org-delegate.ts");
		installOrgDelegate(pi, runtime);
		await pi.startSession();
		const tool = pi.tools.get("org_delegate")!;
		// sales delegating to ceo (its ancestor) is not authorized.
		const res = await tool.execute("c1", {
			toUnit: "ceo",
			goal: "x",
			contract: CONTRACT,
			budget: { tokens: 10, costUsd: 0, wallClockSec: 1 },
		});
		assert.equal(res.isError, true);
		assert.match(res.content[0]!.text, /denied/);
	} finally {
		cleanup();
	}
});

// ---- org-context --------------------------------------------------------

test("renderOrgContext lists identity, grants and budget", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = bootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: null, store }),
		});
		installOrgContext(pi, runtime);
		await pi.startSession();
		const text = renderOrgContext(runtime);
		assert.match(text, /unit \*\*sales\*\*/);
		assert.match(text, /path:rw:\/d\/sales/);
		assert.match(text, /Remaining budget/);

		const event: BeforeAgentStartEvent = { messageType: "user", systemPromptOptions: { sections: {} } };
		await pi.fireBeforeAgentStart(event);
		assert.ok(event.systemPromptOptions.sections.org_context);
	} finally {
		cleanup();
	}
});

// ---- org-trust ----------------------------------------------------------

test("decideTrust trusts only the unit's own tree", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		const runtime = bootstrap(pi, {
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

// ---- org-budget (FR6) ---------------------------------------------------

test("usageToBudget sums tokens and keeps cost", () => {
	assert.deepEqual(usageToBudget({ inputTokens: 10, outputTokens: 5, costUsd: 0.2 }), { tokens: 15, costUsd: 0.2, wallClockSec: 0 });
	assert.deepEqual(usageToBudget({ totalTokens: 42 }), { tokens: 42, costUsd: 0, wallClockSec: 0 });
	assert.deepEqual(usageToBudget(undefined), { tokens: 0, costUsd: 0, wallClockSec: 0 });
});

test("handleTurnEnd meters usage and trips once over budget", async () => {
	const { store, dbPath, cleanup } = makeOrg();
	const pi = new FakePi();
	try {
		// Give sales a tiny unit ceiling by delegating a small budget task from ceo.
		const del = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "g", contract: CONTRACT, budget: { tokens: 1000, costUsd: 100, wallClockSec: 100 } });
		assert.ok(del.ok);
		store.startTask(del.taskId);

		const runtime = bootstrap(pi, {
			env: { [ENV_UNIT]: "sales", [ENV_DB]: dbPath, [ENV_TASK]: del.taskId },
			openClient: () => new LocalControlClient({ unitId: "sales", taskId: del.taskId, store }),
		});
		await pi.startSession();

		const state: BudgetHookState = { tripped: false };
		const over: Array<keyof Budget>[] = [];
		// sales ceiling is BIG (100000 tokens); meter a huge turn to exceed it.
		await handleTurnEnd(runtime, { usage: { totalTokens: 100001 } }, state, (dims) => over.push(dims));
		assert.equal(state.tripped, true);
		assert.ok(over.length === 1 && over[0]!.includes("tokens"));
		// Second over-budget turn does not double-report.
		await handleTurnEnd(runtime, { usage: { totalTokens: 10 } }, state, (dims) => over.push(dims));
		assert.equal(over.length, 1);
	} finally {
		cleanup();
	}
});
