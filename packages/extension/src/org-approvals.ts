/**
 * org-approvals: the `/approvals` Pi command (ADR-0007, SPEC G8). It lets the
 * human owning the current unit view and resolve the approvals routed to them,
 * from inside their own Pi session. Reads and writes go through the unit's
 * ControlClient — which is owner-scoped by the control plane — so the control
 * plane stays the single writer of control.db.
 *
 * Usage inside a session:
 *   /approvals                      list open approvals for this unit's owner
 *   /approvals approve <id> [choice]
 *   /approvals deny <id> [choice]
 */

import type { ApprovalRow } from "pi-agentic-control-plane";
import type { OrgRuntime } from "./bootstrap.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi-api.ts";

function formatApproval(a: ApprovalRow): string {
	const opts = a.options.length ? ` [${a.options.join(", ")}]` : "";
	return `${a.id}  task=${a.taskId}  "${a.question}"${opts}  expires=${a.expiresAt}`;
}

export function installOrgApprovals(pi: ExtensionAPI, runtime: OrgRuntime): void {
	if (!runtime.enabled) return;

	pi.registerCommand("approvals", {
		description: "List or resolve approvals routed to this unit's owner (approve/deny <id> [choice]).",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const notify = (message: string): void => ctx.ui?.notify?.(message, "info");
			const client = runtime.client;
			if (!client) {
				await notify("approvals: control plane not ready");
				return;
			}
			const [sub, id, choice] = args.trim().split(/\s+/).filter((s) => s.length > 0);
			if (!sub || sub === "list") {
				const open = await client.listApprovals();
				if (open.length === 0) {
					await notify("no open approvals");
					return;
				}
				await notify(open.map(formatApproval).join("\n"));
				return;
			}
			if (sub === "approve" || sub === "deny") {
				if (!id) {
					await notify(`approvals: ${sub} needs an approval id`);
					return;
				}
				const decision = sub === "approve" ? "approved" : "denied";
				try {
					const a = await client.resolveApproval(id, decision, choice);
					await notify(`approval ${a.id} ${a.status} (decision=${a.decision ?? ""})`);
				} catch (e) {
					await notify(`approvals: ${(e as Error).message}`);
				}
				return;
			}
			await notify(`approvals: unknown subcommand '${sub}' (use list|approve|deny)`);
		},
	});
}
