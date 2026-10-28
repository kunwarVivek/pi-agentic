# ADR-0002: Pi hooks are the policy enforcement point, not the trust boundary

Status: Accepted · 2026-10-26

## Context
Extensions run in the same process as the agent, with full OS permissions. A `tool_call` hook can block the structured tools reliably. It cannot limit what a `bash` command does once the command runs. Changing the working directory does not limit file access either.

## Decision
1. The `org-policy` hook enforces deny-by-default grants for every tool. It resolves paths of structured file tools with realpath before matching. If the policy check throws, the tool call is blocked.
2. `bash` is denied unless the unit holds the exact `tool:bash` grant (`tool:*` and other wildcards never cover a shell tool). A granted bash call is confined by the same hook: on an allow, the `tool_call` handler rewrites `input.command` to a single shell-quoted `bwrap … /bin/bash -c '<original>'` line built by `buildBwrapCommand` from the unit's path grants, which Pi's bash tool then executes. The deploy renderer sets `ORG_BWRAP=1` (and optionally `ORG_BWRAP_BIN`) for units holding `tool:bash`. Without `ORG_BWRAP`, the granted bash call is blocked (fail closed) unless `AGENTIC_PI_DEV=1` or `AGENTIC_PI_UNSANDBOXED_BASH=1` explicitly opts out. `powershell` cannot be routed through bwrap and is blocked when sandboxing is required.
3. The trust boundary is the OS user or VM (a separate Unix user per unit plus systemd hardening, S6). The hook, including the bwrap rewrite, is defence in depth plus intent control.

## Consequences
- \+ We get fast and testable policy with clear reasons in the audit log.
- \- The guarantees for bash still depend on the deployment: `ORG_BWRAP=1` and a working `bwrap` binary must be present on the host. When they are absent the call fails closed rather than running unsandboxed.
