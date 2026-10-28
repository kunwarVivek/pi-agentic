/**
 * `org notifications` — the operator view of the owner inbox (SPEC FR8): lifecycle
 * notices (expired / retired / deprecated units) and child-task outcomes addressed to
 * an owner, readable even when the unit has no live session.
 *
 * Pure w.r.t. process/IO like approvals.ts: takes an inbox client and the argv tail.
 */

import type { NotificationRow } from "pi-agentic-control-plane";
import type { CommandOutput } from "./approvals.ts";

/** The subset of AdminClient the notifications command needs (keeps it testable). */
export interface NotificationInbox {
	listNotifications(): Promise<NotificationRow[]>;
	ackNotification(id: string): Promise<void>;
}

const USAGE = [
	"usage: org notifications [list|ack <id>]",
	"  list        show unacknowledged notifications (default)",
	"  ack <id>    acknowledge one notification",
].join("\n");

/** One notification as a single line; `data` is JSON-encoded so child-authored text cannot break the line. */
export function formatNotification(n: NotificationRow): string {
	return `${n.id}  owner=${n.owner ?? "-"}  unit=${n.unitId}  ${n.kind}  subject=${n.subject}  at=${n.createdAt}  data=${JSON.stringify(n.data)}`;
}

export async function runNotifications(inbox: NotificationInbox, argv: readonly string[]): Promise<CommandOutput> {
	const [sub, ...rest] = argv;
	switch (sub) {
		case undefined:
		case "list": {
			const notes = await inbox.listNotifications();
			if (notes.length === 0) return { lines: ["no unacknowledged notifications"], exitCode: 0 };
			return { lines: notes.map(formatNotification), exitCode: 0 };
		}
		case "ack": {
			const id = rest[0];
			if (!id) return { lines: ["error: ack needs a notification id", USAGE], exitCode: 2 };
			await inbox.ackNotification(id);
			return { lines: [`notification ${id} acknowledged`], exitCode: 0 };
		}
		default:
			return { lines: [`error: unknown subcommand '${sub}'`, USAGE], exitCode: 2 };
	}
}
