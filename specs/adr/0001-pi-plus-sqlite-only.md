# ADR-0001: Build only from Pi extensions and SQLite

Status: Accepted · 2026-10-26

## Context
We want every control in the tweet's seven steps (governance, gates, handoffs, step functions) without depending on an agent platform vendor. Pi 1.4.0 gives us lifecycle hooks: `tool_call` (block or mutate), `tool_result` (redact or replace), `before_agent_start`, `project_trust`, provider hooks, and `registerTool` / `registerCommand`. Node 24 ships `node:sqlite`.

## Decision
- The core logic is pure TypeScript with no I/O.
- Persistence uses `node:sqlite` in WAL mode.
- Integration with Pi happens only through extensions in one package (`agentic-pi`).
- We take no runtime dependencies beyond Pi and Node built-ins.

## Consequences
- \+ We can audit everything ourselves and the supply chain is small.
- \- There is no high availability. Each DB has one writer process.
- \- `node:sqlite` is still flagged experimental in some Node versions, so we pin Node ≥ 24.
