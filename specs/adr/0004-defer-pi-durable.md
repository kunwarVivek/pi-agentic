# ADR-0004: Use our own SQLite task state machine; defer pi-durable

Status: Superseded by ADR-0009 · 2026-10-26

## Context
`@earendil-works/pi-durable` 1.4.0 is marked "Experimental. API changes without notice". It is a separate harness with its own extension API. It has no locking across processes.

## Decision
- Tasks, retries, deadlines and escalations live in `control.db`, in a small explicit state machine: `queued → running → (done | rejected → queued | escalated | failed | cancelled)`.
- We will revisit pi-durable for durable execution inside a unit once its API is stable.

## Consequences
- \+ The state machine is stable and testable, and we own it.
- \- We have to implement timers and retries ourselves. The scheduler slice (S5) does this.
