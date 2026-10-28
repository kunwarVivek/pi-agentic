/**
 * S7 tests: the `org approvals` command core (pure, fake inbox) and the
 * env-driven `runCli` wiring (fake env + out sink, real AdminClient over a
 * live socket).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseManifest, type Budget, type Manifest } from "pi-agentic-core";
import type { Contract } from "pi-agentic-core";
import {
	ControlServer,
	ControlStore,
	PeerRegistry,
	type ApprovalRow,
} from "pi-agentic-control-plane";
import { formatApproval, runApprovals, type Inbox } from "../src/approvals.ts";
import { runCli } from "../src/main.ts";

const APPROVAL = (over: Partial<ApprovalRow> = {}): ApprovalRow => ({
	id: "appr_0001",
	taskId: "task_0001",
	question: "ship it?",
	options: ["yes", "no"],
	owner: "sales@co",
	status: "open",
	decision: null,
	decidedBy: null,
	expiresAt: "2026-01-02T00:00:00.000Z",
	createdAt: "2026-01-01T00:00:00.000Z",
	holderUnitId: "sales",
	...over,
});

/** A fake inbox that records resolve calls. */
function fakeInbox(open: ApprovalRow[]): Inbox & { resolved: Array<[string, string, string | undefined]> } {
	const resolved: Array<[string, string, string | undefined]> = [];
	return {
		resolved,
		listApprovals: () => Promise.resolve(open),
		resolveApproval: (id, decision, choice) => {
			resolved.push([id, decision, choice]);
			return Promise.resolve(APPROVAL({ id, status: decision === "approved" ? "approved" : "denied", decision: choice ?? decision }));
		},
	};
}

test("runApprovals list: empty vs populated", async () => {
	const empty = await runApprovals(fakeInbox([]), ["list"]);
	assert.deepEqual(empty, { lines: ["no open approvals"], exitCode: 0 });

	const full = await runApprovals(fakeInbox([APPROVAL()]), ["list"]);
	assert.equal(full.exitCode, 0);
	assert.match(full.lines[0]!, /appr_0001/);
	assert.match(full.lines[0]!, /ship it\?/);
});

test("runApprovals approve/deny forwards id, decision and choice", async () => {
	const inbox = fakeInbox([APPROVAL()]);
	const ok = await runApprovals(inbox, ["approve", "appr_0001", "yes"]);
	assert.equal(ok.exitCode, 0);
	assert.match(ok.lines[0]!, /approved/);
	assert.deepEqual(inbox.resolved, [["appr_0001", "approved", "yes"]]);

	const d = fakeInbox([APPROVAL()]);
	await runApprovals(d, ["deny", "appr_0002"]);
	assert.deepEqual(d.resolved, [["appr_0002", "denied", undefined]]);
});

test("runApprovals rejects missing id and unknown subcommand", async () => {
	const noId = await runApprovals(fakeInbox([]), ["approve"]);
	assert.equal(noId.exitCode, 2);
	assert.match(noId.lines[0]!, /needs an approval id/);

	const bad = await runApprovals(fakeInbox([]), ["frobnicate"]);
	assert.equal(bad.exitCode, 2);
	assert.match(bad.lines[0]!, /unknown subcommand/);
});

test("formatApproval renders a single scannable line", () => {
	const line = formatApproval(APPROVAL());
	assert.match(line, /appr_0001/);
	assert.match(line, /task=task_0001/);
	assert.match(line, /owner=sales@co/);
	assert.match(line, /\[yes, no\]/);
});

// ---- runCli wiring over a real socket ------------------------------------

const BIG: Budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };
const man = (id: string, path: string, parent: string | null, grants: string[]): Manifest =>
	parseManifest({ id, path, parent, owner: `${id}@co`, grants, budget: BIG });
const CONTRACT: Contract = {
	schema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string", minLength: 1 } } },
};

test("runCli approvals list speaks to the control plane with an admin token", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agentic-pi-cli-"));
	const socketPath = join(dir, "control.sock");
	const tokenFile = join(dir, "admin.token");
	let n = 0;
	const store = new ControlStore(join(dir, "control.db"), {
		clock: () => Date.parse("2026-01-01T00:00:00.000Z"),
		genId: (p) => `${p}_${String(++n).padStart(4, "0")}`,
	});
	store.addUnit(man("ceo", "ceo", null, ["tool:read", "delegate:*"]));
	store.addUnit(man("sales", "sales", "ceo", ["tool:read"]));
	const reg = new PeerRegistry();
	const adminToken = reg.issueAdminToken();
	writeFileSync(tokenFile, adminToken, { mode: 0o600 });
	const server = new ControlServer({ store, auth: reg });
	await server.listen(socketPath);
	const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "sell", contract: CONTRACT, budget: { tokens: 10, costUsd: 1, wallClockSec: 1 } });
	assert.ok(d.ok);
	const appr = store.escalate(d.ok ? d.taskId : "", "ship?", ["yes", "no"]);

	const lines: string[] = [];
	const env = { ORG_CONTROL_SOCKET: socketPath, ORG_ADMIN_TOKEN_FILE: tokenFile };
	try {
		const listCode = await runCli(["approvals", "list"], env, (l) => lines.push(l));
		assert.equal(listCode, 0);
		assert.ok(lines.some((l) => l.includes(appr.id)), "list shows the open approval");

		const denyCode = await runCli(["approvals", "deny", appr.id], env, (l) => lines.push(l));
		assert.equal(denyCode, 0);
		assert.equal(store.getApproval(appr.id)?.status, "denied");
		assert.equal(store.getTask(d.ok ? d.taskId : "")?.status, "cancelled");
	} finally {
		await server.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runCli rejects an unknown command and missing config", async () => {
	const lines: string[] = [];
	const unknown = await runCli(["frob"], {}, (l) => lines.push(l));
	assert.equal(unknown, 2);
	assert.match(lines[0]!, /unknown command/);

	await assert.rejects(
		() => runCli(["approvals", "list"], {}, () => {}),
		/ORG_CONTROL_SOCKET is required/,
	);
});
