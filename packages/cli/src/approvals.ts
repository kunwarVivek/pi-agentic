/**
 * `org approvals` — the operator view of the human inbox (ADR-0007, SPEC G8).
 *
 * The command core is pure w.r.t. process/IO: it takes an inbox client (the
 * AdminClient in production, a fake in tests) and the argv tail, performs the
 * requested action, and returns the lines to print plus an exit code. `main.ts`
 * wires it to stdout and a real socket.
 */

import type { ApprovalRow } from "@agentic-pi/control-plane";

/** The subset of AdminClient the approvals command needs (keeps it testable). */
export interface Inbox {
	listApprovals(): Promise<ApprovalRow[]>;
	resolveApproval(id: string, decision: "approved" | "denied", choice?: string): Promise<ApprovalRow>;
}

export interface CommandOutput {
	lines: string[];
	exitCode: number;
}

const USAGE = [
	"usage: org approvals <list|approve|deny> [args]",
	"  list                      show open approvals",
	"  approve <id> [choice]     approve an approval (optional chosen option)",
	"  deny <id> [choice]        deny an approval (optional chosen option)",
].join("\n");

/** One approval rendered as a single scannable line. */
export function formatApproval(a: ApprovalRow): string {
	const opts = a.options.length ? ` [${a.options.join(", ")}]` : "";
	return `${a.id}  task=${a.taskId}  owner=${a.owner}  "${a.question}"${opts}  expires=${a.expiresAt}`;
}

/**
 * Run the approvals command. `argv` is the tail after `approvals`
 * (e.g. ["list"] or ["approve", "appr_123", "yes"]).
 */
export async function runApprovals(inbox: Inbox, argv: readonly string[]): Promise<CommandOutput> {
	const [sub, ...rest] = argv;
	switch (sub) {
		case "list": {
			const open = await inbox.listApprovals();
			if (open.length === 0) return { lines: ["no open approvals"], exitCode: 0 };
			return { lines: open.map(formatApproval), exitCode: 0 };
		}
		case "approve":
		case "deny": {
			const id = rest[0];
			if (!id) return { lines: [`error: ${sub} needs an approval id`, USAGE], exitCode: 2 };
			const choice = rest[1];
			const decision = sub === "approve" ? "approved" : "denied";
			const a = await inbox.resolveApproval(id, decision, choice);
			return { lines: [`approval ${a.id} ${a.status} (decision=${a.decision ?? ""})`], exitCode: 0 };
		}
		default:
			return { lines: [sub ? `error: unknown subcommand '${sub}'` : "error: missing subcommand", USAGE], exitCode: 2 };
	}
}
