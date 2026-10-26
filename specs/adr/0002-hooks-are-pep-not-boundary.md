# ADR-0002: Pi hooks are the policy enforcement point, not the trust boundary

Status: Accepted · 2026-10-26

## Context
Extensions run in the same process as the agent, with full OS permissions. A `tool_call` hook can block the structured tools reliably. It cannot limit what a `bash` command does once the command runs. Changing the working directory does not limit file access either.

## Decision
1. The `org-policy` hook enforces deny-by-default grants for every tool. It resolves paths of structured file tools with realpath before matching. If the policy check throws, the tool call is blocked.
2. `bash` is denied unless the unit holds the `tool:bash` grant. Units with that grant must run under an OS boundary. In S6 this is a separate Unix user per unit and systemd hardening, plus bubblewrap on Linux or Gondolin for bash.
3. The trust boundary is the OS user or VM. The hook is defence in depth plus intent control.

## Consequences
- \+ We get fast and testable policy with clear reasons in the audit log.
- \- The guarantees for bash depend on how the deployment is set up. The deployment guide must not let `tool:bash` ship without a sandbox.
