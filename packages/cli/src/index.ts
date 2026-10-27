/**
 * @agentic-pi/cli — the operator CLI (`org`). A thin, admin-token RPC client
 * for the human control host (ADR-0007). It never opens control.db directly;
 * the control plane stays the single writer.
 */

export * from "./approvals.ts";
export { runCli } from "./main.ts";
