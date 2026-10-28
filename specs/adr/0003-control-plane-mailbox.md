# ADR-0003: Delegate across units through a control-plane mailbox, not process spawning

Status: Accepted · 2026-10-26

## Context
If the CEO agent spawns subordinate Pi processes, those processes run as the CEO's OS user. They then inherit all of its access, and the boundaries between units disappear.

## Decision
- Cross-unit work happens only through `delegate` / `complete_task` / `escalate` tools that call the control plane.
- The control plane is the only writer of `control.db`.
- The control plane identifies the caller by the socket it connected to. Each unit has its own socket (`/run/pi-control/<id>.sock`, owner `pi-control`, group `pi-u-<id>`, mode 0660, in a 0711 directory), so identity is enforced by OS permissions and needs no token; a `hello` that claims a different unit is rejected. Workers receive only their own socket as `ORG_CONTROL_SOCKET`. The shared socket (`/var/lib/org/control.sock`) keeps token auth and is for the dev (`AGENTIC_PI_DEV=1`) and admin paths only; workers cannot reach it. `SO_PEERCRED` is not used, because `node:net` does not expose it.
- The control plane checks narrowing, budget, depth, fan-out and cycles before it writes to an inbox.
- The dispatcher starts the target unit's worker as that unit's user.
- Inside a unit, subagents are allowed, because they stay in the same trust domain.

## Consequences
- \+ All delegation is in one place, so it is auditable, budgeted and enforceable.
- \- Adds a control-plane process and an RPC protocol.
- \- The control plane is a single point of failure. We accept this for v0.x.
