# ADR-0007: Human approval inbox goes through the control plane

## Status

Accepted.

## Context

S7 delivers the human inbox (SPEC FR5, goal G8): humans approve or deny
escalated tasks from one place, with a TTL, and "no answer → denied". The
approval data already lives in `control.db` (`escalate`, `getApproval`,
`listOpenApprovals`, `resolveApproval`, `expireApprovals`). What was missing is
*how a human reaches those verbs* and *what resolving an approval does to the
task*.

Two forces constrain the design:

1. **Single writer.** The audit chain's `append()` reads the previous hash from
   the DB on every call, so two OS processes writing `control.db` concurrently
   would race the `seq` primary key and either hard-fail or fork the chain. The
   control plane must remain the sole writer (ADR-0003). A human CLI therefore
   must **not** open `control.db` to resolve approvals — it must go through the
   control plane.
2. **No human identity root.** SPEC explicitly excludes building a human
   identity system. Owners are plain strings on units/approvals.

## Decision

- **Resolution drives the task (the round trip).** `resolveApproval` now moves
  the escalated task: **approved → `pending`** (eligible for another dispatch
  attempt) and **denied → `cancelled`** with the reservation released to the
  parent. Root TTL expiry (`expireApprovals`) denies the task the same way, so
  "no answer → denied" is observable on the task, not just the approval.
- **Two RPC methods, owner-scoped.** `list_approvals` and `resolve_approval`
  join the protocol. A connection authenticated as a **unit** may only see and
  resolve approvals whose `owner` equals that unit's owner (`decidedBy` = that
  owner). This powers the `/approvals` Pi command: the owner, running their
  unit's session, sees their own inbox.
- **An admin principal for the operator CLI.** The `org` CLI is the human root
  operating on the control host. The control plane issues one **admin token**
  (mode-600 file, like unit tokens); an admin connection may list and resolve
  **any** approval (`decidedBy` = `"admin"`). This avoids inventing a human
  identity system while still preserving single-writer: the CLI is a thin RPC
  client, never a second DB writer.
- **A new `@agentic-pi/cli` package** (bin `org`) hosts operator commands,
  starting with `org approvals list|approve|deny`. Future operator verbs (units,
  tasks, audit) live here too — the core stays pure and the CLI is just another
  leaf consumer of `@agentic-pi/control-plane`.

## Consequences

- The human inbox is reachable two ways — `/approvals` inside an owner's Pi
  session (owner-scoped) and `org approvals` on the control host (admin) — both
  through the one writer.
- Approve/deny are now meaningful: they advance the task state machine, and the
  budget reservation of a denied task is returned to the parent.
- A Slack bot or web UI later is just another admin-token RPC client; no schema
  or protocol change needed.
