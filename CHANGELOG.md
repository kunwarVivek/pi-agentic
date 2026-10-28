# Changelog

All notable changes to agentic-pi are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the workspace packages are versioned together
(currently all at `0.1.0`).

## [0.1.0] - 2026-10-28

First release: an agentic org on Pi 1.4.0, built from Pi extensions and `node:sqlite` only
([ADR-0001](specs/adr/0001-pi-plus-sqlite-only.md)). Seven workspace packages, Node >= 24.

### Added

**Org model and policy (`pi-agentic-core`)**
- `unit.json` manifest parser, fail closed: `id`, `path`, `parent`, `owner`, `grants`, `budget`, `limits`
  (`maxDepth` 4, `maxChildren` 8, `maxAttempts` 2 by default), `expiresAt`, `minEval`, `secrets` (env var names)
  and `trust` (project directories).
- Grant grammar `tool:`, `path:<r|rw>:`, `delegate:`, `mcp:`, `host:` with narrowing (`child ⊆ parent`) and
  task-grant intersection; path patterns limited to `/a/b`, `/a/b/*`, `/a/b/**`; `bash`/`powershell` only by exact
  grant.
- Default-deny policy decision point over tool names and realpath-resolved paths.
- Delegation rules: descendant or explicit `delegate:` grant, no grant widening, budget reservation, depth, fan-out
  and cycle limits.
- Handoff gate chain: JSON Schema subset, then rules (`forbiddenKeys`, `forbiddenPatterns`, `maxBytes`), then an
  optional judge; unsupported schema keywords are rejected.
- Hash-chained audit log, with an off-host anchor for detecting a rebuilt chain.

**Control plane (`pi-agentic-control-plane`)**
- Single-writer `control.db` store: units, tasks, artifacts (by sha256), approvals, budgets, notifications, evals
  and the audit chain, with an injectable clock.
- JSON-lines RPC over Unix sockets, one socket per unit as the identity, plus a shared admin/dev socket with an
  operator admin token; protocol version 1.
- Dispatcher with `systemd`, `uid` and `dev` worker spawners and an allowlisted worker environment.
- Scheduler: lifecycle transitions (expiry to `suspended`, 90 days idle to `retired`, low eval to `deprecated`),
  approval TTL expiry (24 h, climbs one level, denied at the root) and dispatch.
- Budget metering across tokens, cost and wall-clock, rolled up the delegation chain, with escalation (`extend` /
  `cancel`) on exhaustion.
- `pi-control` daemon and the `ControlClient` library (in-process and socket) plus the operator `AdminClient`.

**Pi extension (`pi-agentic`)**
- Default-deny `tool_call` enforcement with audited decisions, `.pi`/`.agents` plant protection, and bubblewrap
  routing for `bash`.
- `tool_result` secret redaction (declared secrets, `auth.json` values, credential patterns, structured content).
- `org_delegate`, `org_complete`, `org_escalate` tools; identity/grants/budget context and notification injection;
  manifest-grounded project trust; per-turn budget metering that aborts over-budget sessions.
- `/approvals` command for the unit owner's inbox.
- Installable as a Pi package (`pi-package` keyword, `pi.extensions`).

**Deployment (`pi-agentic-deploy`)**
- Hardened `pi-control.service` and per-unit `pi-unit@<id>.service` / `pi-durable@<id>.service` generators,
  sysusers/tmpfiles fragments, a polkit rule, root-owned manifest and `secrets.env` layout, bubblewrap argv from
  path grants, and the `org-render` CLI.

**Operator CLI (`pi-agentic-cli`)**
- `org approvals list|approve|deny` and `org notifications [list|ack <id>]` over the admin token.

**Evals (`pi-agentic-evals`)**
- `runSuite`, `parseSuite` and `runAndRecord`, feeding `minEval`-based deprecation.

**Durable worker (`pi-agentic-durable`)**
- `agentic-pi-durable-worker`: one pi-durable Harness per task with single-owner storage locking, restart-safe
  submission and the same policy, redaction, metering and `org_*` tools as the Pi extension
  ([ADR-0009](specs/adr/0009-adopt-pi-durable-in-units.md)).

**Tooling and docs**
- `npm run check`, `build`, `smoke:pi`, `simulate:org`, `release:check`; `scripts/smoke.sh` Linux deployment gate.
- README, [User Guide](docs/USER_GUIDE.md), [Developer Guide](docs/DEVELOPER_GUIDE.md),
  [Configuration reference](docs/CONFIGURATION.md), [Deployment guide](docs/DEPLOY.md), per-package READMEs.

### Known limitations

- Not yet published to npm; install from a checkout.
- There is no operator command to register units; use `ControlStore.addUnit(parseManifest(...))`.
- `mcp:` and `host:` grants are parsed and narrowed but not yet enforced on tool calls.
- The `pi-control` daemon does not read `ORG_WORKER_MODE` and has no judge configured: durable mode is selected
  only programmatically, and contracts with `judge: true` are refused at delegation.
- `org-render`'s default `ORG_ENTRYPOINT` is a stale path; always set it.
