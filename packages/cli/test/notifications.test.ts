/** `org notifications` (FR8 owner inbox): pure command core over a fake inbox. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { NotificationRow } from "pi-agentic-control-plane";
import { formatNotification, runNotifications, type NotificationInbox } from "../src/notifications.ts";

const NOTE = (over: Partial<NotificationRow> = {}): NotificationRow => ({
	id: "note_1",
	unitId: "eng",
	owner: "boss@co",
	kind: "unit.lifecycle",
	subject: "eng",
	data: { from: "active", to: "suspended", reason: "expired" },
	createdAt: "2026-01-02T00:00:00.000Z",
	ackedAt: null,
	...over,
});

function fake(notes: NotificationRow[]): NotificationInbox & { acked: string[] } {
	const acked: string[] = [];
	return { acked, listNotifications: async () => notes, ackNotification: async (id) => void acked.push(id) };
}

test("notifications list: empty vs populated; default subcommand is list", async () => {
	assert.deepEqual((await runNotifications(fake([]), [])).lines, ["no unacknowledged notifications"]);
	const out = await runNotifications(fake([NOTE()]), ["list"]);
	assert.equal(out.exitCode, 0);
	assert.equal(out.lines.length, 1);
	assert.match(out.lines[0]!, /note_1 {2}owner=boss@co {2}unit=eng {2}unit\.lifecycle/);
});

test("notifications: child-authored text cannot break out of its line (data is JSON-encoded)", () => {
	const line = formatNotification(NOTE({ kind: "task.escalated", data: { question: "x\nnote_2  owner=evil" } }));
	assert.equal(line.includes("\n"), false);
});

test("notifications ack forwards the id; missing id and unknown subcommand are usage errors", async () => {
	const inbox = fake([]);
	assert.equal((await runNotifications(inbox, ["ack", "note_9"])).exitCode, 0);
	assert.deepEqual(inbox.acked, ["note_9"]);
	assert.equal((await runNotifications(inbox, ["ack"])).exitCode, 2);
	assert.equal((await runNotifications(inbox, ["frob"])).exitCode, 2);
});
