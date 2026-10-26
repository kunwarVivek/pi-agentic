# ADR-0003: Delegate across units through a control-plane mailbox, not process spawning

Status: Accepted · 2026-10-26

## Context
If the CEO agent spawns subordinate Pi processes, those processes run as the CEO's OS user. They then inherit all of its access, and the boundaries between units disappear.

## Decision
- Cross-unit work happens only through `delegate` / `complete_task` / `escalate` tools that call the control plane.
- The control plane is the only writer of `control.db`.
- The control plane authenticates the caller by the peer uid of the Unix socket (Linux, `SO_PEERCRED`). In development, it uses a per-unit token file with mode 600.
- The control plane checks narrowing, budget, depth, fan-out and cycles before it writes to an inbox.
- The dispatcher starts the target unit's worker as that unit's user.
- Inside a unit, subagents are allowed, because they stay in the same trust domain.

## Consequences
- \+ All delegation is in one place, so it is auditable, budgeted and enforceable.
- \- Adds a control-plane process and an RPC protocol.
- \- The control plane is a single point of failure. We accept this for v0.x.
