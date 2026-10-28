/**
 * pi-agentic-cli — the operator CLI (`org`). A thin, admin-token RPC client
 * for the human control host (ADR-0007). It never opens control.db directly, except the
 * explicit offline `org units sync --db` (daemon stopped); otherwise the control plane stays
 * the single writer.
 */

export * from "./approvals.ts";
export * from "./notifications.ts";
export * from "./units.ts";
export { runCli } from "./main.ts";
