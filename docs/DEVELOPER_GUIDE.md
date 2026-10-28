# Developer Guide

For contributors. Operators should start with the [User Guide](USER_GUIDE.md) and [DEPLOY.md](DEPLOY.md);
environment variables are in [CONFIGURATION.md](CONFIGURATION.md). The decisions behind the design are the ADRs in
[specs/adr](../specs/adr) and the requirements in [specs/SPEC.md](../specs/SPEC.md).

## Ground rules

- **Node ≥ 24, `node:sqlite`, no third-party runtime dependencies in the core**
  ([ADR-0001](../specs/adr/0001-pi-plus-sqlite-only.md)). Only `pi-agentic-durable` depends on `@earendil-works/*`
  packages, because it is a standalone worker, not a Pi extension.
- **Default deny, fail closed.** If a decision or an audit write throws, the call is blocked.
- **Pure core.** `pi-agentic-core` does no I/O. Time comes from an injected clock.
- **One writer.** Only the control plane process writes `control.db`; workers go through RPC.
- New capability = a new package or module. Packages form an acyclic graph (core → control-plane → the rest).
- Sources are `.ts` with explicit `.ts` import extensions; cross-package imports use the package name, never deep
  relative paths.

## Repo layout

```text
packages/
  core/          pure kernel (manifest, grants, policy, delegation, budget, gates, audit, regex-safety)
  control-plane/ store, protocol, auth, server, dispatcher, scheduler, spawners, clients, pi-control daemon
  extension/     the Pi extension (hooks, tools, /approvals) + shared host-neutral policy pieces
  deploy/        systemd generators, bwrap argv, org-render CLI
  cli/           org operator CLI (approvals, notifications)
  evals/         eval suite runner and recorder
  durable/       pi-durable worker (one Harness per task)
scripts/         smoke-pi-ext.ts, simulate-org.ts, smoke.sh (+ helpers), release-check.ts
specs/           SPEC.md, PLAN.md, adr/
docs/            this guide set
```

| Package | Source files |
|---|---|
| core | `manifest.ts` (`unit.json` parser), `grants.ts` (grammar, narrowing, path match), `policy.ts` (PDP `decide`), `delegation.ts` (`checkDelegation`), `budget.ts`, `gates.ts` (schema → rules → judge), `audit.ts` (hash chain, anchors), `regex-safety.ts` |
| control-plane | `store-control.ts` (`ControlStore`, all SQL), `protocol.ts`, `auth.ts` (`PeerRegistry`), `server.ts` (`ControlServer`), `dispatcher.ts`, `scheduler.ts`, `spawners.ts` (dev/uid/systemd), `control-client.ts` (`ControlClient`, `LocalControlClient`), `socket-client.ts`, `admin-client.ts`, `unit-config.ts`, `control-plane.ts` (`startControlPlane`, the `pi-control` bin) |
| extension | `index.ts` (default export), `bootstrap.ts`, `org-policy.ts`, `policy-hook.ts`, `redact.ts`, `sandbox.ts`, `org-delegate.ts`, `org-context.ts`, `org-trust.ts`, `org-budget.ts`, `org-approvals.ts`, `pi-api.ts` (local Pi API types), `shared.ts` (the `./shared` export) |
| deploy | `systemd.ts`, `bwrap.ts`, `render.ts` (the `org-render` bin) |
| cli | `main.ts` (the `org` bin), `approvals.ts`, `notifications.ts` |
| evals | `runner.ts` (`runSuite`), `suite.ts` (`parseSuite`), `record.ts` (`runAndRecord`) |
| durable | `worker.ts` (the `agentic-pi-durable-worker` bin), `run.ts` (`runDurableTask`), `org-extension.ts`, `lock.ts`, `model-config.ts`, `notifications.ts` |

## Build, test, run

```sh
npm install
npm run typecheck     # tsc --build (all packages) + tsc -p tsconfig.tests.json (tests)
npm test              # node --test over packages/*/test/**/*.test.ts, no build needed
npm run check         # typecheck + test
npm run build         # emit dist/ (.js + .d.ts) for every package
npm run clean         # tsc --build --clean
npm run smoke:pi      # build, then load the extension into the real `pi` with a scripted fake model
npm run simulate:org  # build, then a full org rehearsal under ./.tmp/sim-* (add `-- --keep` to retain)
npm run release:check # pack + `npm publish --dry-run` + isolated consumer install; never publishes
pnpm run publish <patch|minor|major|X.Y.Z>   # cut a release: see "Releasing" below
sudo REPO=/opt/agentic-pi bash scripts/smoke.sh   # Linux + systemd + bwrap gate, see DEPLOY.md
```

How `pi-agentic*` resolves: every package's `exports` has a `development` condition → `./src/index.ts` and a
default → `./dist/index.js`. Tests and the scripts run Node with `--conditions development --experimental-strip-types`,
so they execute the `.ts` directly. Published consumers get the `tsc` output, where
`rewriteRelativeImportExtensions` has turned `.ts` specifiers into `.js`.

`smoke:pi` and `simulate:org` need `pi` on `PATH` and no model keys. Re-run them after every Pi upgrade.

## Pi host contract (Pi 1.4.0)

The extension API surface the code depends on, verified against Pi's `types.d.ts` and `runner.js`. Re-check these
when upgrading Pi; `npm run smoke:pi` is the executable version.

- Every handler is `(event, ctx) => result | void | Promise<...>`; `pi.on` returns an unsubscribe function. `ctx`
  has `ui`, `mode`, `hasUI`, `cwd`, `signal`, `abort()`, `shutdown()`, `isIdle()`.
- The runner wraps **every handler except `tool_call`** in try/catch and reports the error: a throw there **never
  stops the session**. To stop work use `ctx.abort()`. A `tool_call` handler is not wrapped; a throw there becomes
  "Extension failed, blocking execution", and a result `{ block: true, reason }` blocks the call. `event.input` is
  mutable (the bubblewrap rewrite relies on it).
- `tool_result` receives a **shallow copy**, so mutating it does nothing: the handler must **return**
  `{ content?, structuredContent?, details?, isError? }`. Returning `content` without `structuredContent` **drops**
  `structuredContent`, so redaction returns both.
- `turn_end` has **no `usage`**. Usage lives on the assistant message: `event.message.usage` =
  `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { total, ... } }`; non-assistant messages have none.
  `turn_start` carries `timestamp` (ms), used for wall-clock metering.
- `before_agent_start`: `event.systemPromptOptions.sections` is a mutable record later handlers observe; the result
  may carry `message` (a custom message). Org context goes into `sections.org_context`; notifications are returned
  as a displayed custom message.
- `project_trust`: `handler({ cwd }, ctx) → { trusted: "yes" | "no" | "undecided", remember? }`, fired **before**
  `session_start`, and only extensions loaded as personal/`-e` participate. That is why the extension connects to the
  control plane inside this handler and why a unit's extension is installed in personal scope.
- `registerTool` needs `label` (required), `description`, `parameters` (TypeBox/JSON Schema),
  `execute(toolCallId, params, signal, onUpdate, ctx)`. `registerCommand(name, { description, handler(args, ctx) })`;
  `ctx.ui.notify(message, type?)`.
- Built-in tool path semantics the PEP mirrors (`policy-hook.ts`): `~` and `@` prefixes, unicode spaces normalized,
  `grep`/`find`/`ls` default a missing path to the cwd.
- The extension imports **no Pi host package** at runtime: `pi-api.ts` is a local types-only subset, so there is no
  duplicate-class risk and no `peerDependencies` entry.

## How the hooks work

All five installers share one `OrgRuntime` created by `bootstrap(pi)` (`bootstrap.ts`). `index.ts` wires them:
policy, delegate, context, trust, budget, approvals.

### Bootstrap and the fail-closed lifecycle

`bootstrap` reads the environment (`ORG_UNIT_ID`, `ORG_CONTROL_SOCKET`, `ORG_UNIT_MANIFEST`, ...). With no org
configuration it either returns an inert runtime (`AGENTIC_PI_DEV=1`) or records a `failure` string that makes
every gate refuse. `runtime.connect()` loads and validates `unit.json` (id must equal `ORG_UNIT_ID`; outside dev it
must not lie inside a `path:rw:` grant), computes the secret values to redact, then opens the client: a
`SocketControlClient` when `ORG_CONTROL_SOCKET` is set, otherwise (dev only) a `LocalControlClient` over
`ORG_CONTROL_DB`. `session_start` connects; `turn_start` refreshes the cached snapshot, and a failed refresh
**drops the client** so every gate fails closed with no stale grants; `session_shutdown` closes it.

### PEP: `tool_call` (`org-policy.ts`, `policy-hook.ts`)

1. No client → block with the runtime failure.
2. `decideToolCall`: the `org_*` tools are exempt (they are checked and audited by the control plane). Otherwise
   `fileAccess` maps `read`/`grep`/`find`/`ls` (`r`) and `write`/`edit` (`rw`) to a **realpath**
   (`nearestRealpath`, falling back to the nearest existing ancestor). A write into `<cwd>/.pi`, `<cwd>/.agents`
   or the same inside a `trust` dir throws (non-dev). Grants are canonicalized with the same resolver
   (`canonicalizePathGrants`), then core's `decide(grants, request)` runs: tool covered, then every path matched.
3. The decision, allowed or denied, is appended to the audit chain with `client.recordDecision`. **If the audit write
   fails the call is blocked.** Any exception becomes a deny.
4. An allowed `bash` call goes to `sandboxShellCall`: depending on `ORG_BWRAP` / dev flags it rewrites
   `input.command` to a single shell-quoted `bwrap ... /bin/bash -c '<original>'` line built by
   `pi-agentic-deploy`'s `buildBwrapCommand` from the unit's path grants, passes it unsandboxed (dev or
   `AGENTIC_PI_UNSANDBOXED_BASH=1`), or blocks it.

### Redaction: `tool_result`

`redactLiterals` replaces the values of the manifest `secrets` env vars (plus `auth.json` string values ≥ 8 chars),
longest first; then `redactSecrets` (`redact.ts`) applies pattern rules and sensitive-key rules (`password`,
`token`, `api_key`, ...; count-style keys like `max_tokens` are exempt). `redactJson` walks `structuredContent`.
The handler returns `{ content, structuredContent }` only when something changed.

### Budget: `turn_start` / `turn_end` (`org-budget.ts`)

`turn_start` stores the timestamp. `turn_end` maps the assistant message `usage` through `usageToBudget`
(`totalTokens`, else the sum of input/output/cache; `cost.total`; non-finite or negative counts as 0), adds the turn's
wall-clock seconds and calls `client.meter(taskId, usage)`. If the result lists `overBudget` dimensions, or the
client is missing, the usage is absent, or metering throws, the handler notifies and calls `ctx.abort()` once
(a throw would be swallowed by the runner). The control store raises the escalation inside the same transaction as
the usage update.

### Trust: `project_trust` (`org-trust.ts`)

Connects, then answers `yes` only if the realpath of `cwd` is inside a realpath'd `trust` directory of the manifest;
everything else, including any error, is `no`. Path grants never imply trust.

### Context and notifications: `before_agent_start` (`org-context.ts`)

Adds `sections.org_context`: unit id/path/parent/owner, effective grants, remaining budget, the current task and its
contract. Unread notifications are acknowledged and returned as a displayed `org_notifications` custom message.
Text from other units appears only inside a delimited, clipped `untrusted` field.

### Tools and commands

`org-delegate.ts` registers `org_delegate`, `org_complete`, `org_escalate` (thin wrappers over the client).
`org-approvals.ts` registers `/approvals`. All of them are no-ops when the runtime is inert.

## Control-plane RPC protocol

Transport: a Unix socket carrying newline-delimited JSON (`LineDecoder`, 1 MiB line cap, `PROTOCOL_VERSION = 1`).
Request `{ id: number, method, params }`; response `{ id, ok: true, result }` or
`{ id, ok: false, error: { code, message } }`, with codes `unauthenticated`, `forbidden`, `bad_request`,
`not_found`, `internal`, `version_mismatch`. Requests are serialized through one promise chain so store
transactions never overlap. Source: `protocol.ts`, `server.ts`.

**The caller's unit is never taken from a request body.** The first request must be `hello` with
`{ version, token?, unitId?, taskId? }`. The server authenticates the connection and pins the principal for it
(`unit` or `admin`; `authenticate` in `auth.ts`). On a per-unit socket the identity is the socket: a claimed
`unitId` that differs, the admin token, or another unit's token is rejected. On the shared socket the order is peer
uid, then admin token, then unit token. A `taskId` is honoured only if that task is assigned to the unit.

| Method | Caller | Params | Result |
|---|---|---|---|
| `hello` | any | `version`, `token?`, `unitId?`, `taskId?` | `{ unitId, snapshot }` |
| `snapshot` | any | none | `WorkerSnapshot`: unit, pinned task, remaining budget, unread notifications |
| `delegate` | unit | `toUnit`, `goal`, `contract`, `grants?` (strings), `budget` (`parentTask` is the pinned task) | `DelegateResult`: `{ ok: true, taskId }` or `{ ok: false, code, reason }` |
| `complete_task` | unit | `taskId`, `artifact` | `CompleteResult` (done / rejected / escalated / error) |
| `escalate` | unit | `taskId`, `question`, `options[]` | `ApprovalRow` |
| `meter` | unit | `taskId`, `usage` (`Budget`) | `{ used, overBudget[], escalation }` |
| `record_decision` | unit | `toolName`, `allow`, `paths[{path, mode}]`, `reason?` | `null` (audit append) |
| `list_approvals` | unit, admin | none | open approvals; a unit sees only its owner's, admin all |
| `resolve_approval` | unit, admin | `id`, `decision` (`approved`\|`denied`), `choice?` | `ApprovalRow`; a unit may only resolve its owner's |
| `list_notifications` | unit, admin | none | unacknowledged owner-inbox notifications (unit: its owner's, admin: all) |
| `ack_owner_notification` | unit, admin | `id` | `null`; `not_found` if unknown/foreign/acked |
| `ack_notification` | unit only | `id` | `null`; acks the unit's own notification |

`complete_task`, `escalate` and `meter` are refused (`forbidden`) for a task not assigned to the caller's unit. The
shared socket (`ORG_CONTROL_SOCKET` of `pi-control`) accepts the admin token; per-unit sockets
(`ORG_UNIT_SOCKET_DIR/<id>.sock`, mode 0660 `pi-control:pi-u-<id>`) identify the unit by the socket itself.
`AdminClient` (`admin-client.ts`) is the operator-side library the `org` CLI uses.

## Durable worker (`pi-agentic-durable`)

`agentic-pi-durable-worker` (`worker.ts`) is the dispatcher's `durable` worker mode
([ADR-0009](../specs/adr/0009-adopt-pi-durable-in-units.md)). `runDurableTask` runs **one** control-plane task in
**one** pi-durable Harness. `control.db` stays authoritative for task lifecycle; the pi-durable SQLite file
`<ORG_DURABLE_DIR>/<taskId>.db` holds only conversation and tool-execution state and is owned by one process at a
time through `<taskId>.lock` (`lock.ts`: `O_EXCL` file with pid + nonce, stale-owner takeover, fail closed on a
live pid). The goal is submitted with `requestId = taskId` (`taskId:<generation>` after a re-queue), so a restarted
worker finds its submission instead of duplicating it and `Harness.resume()` continues pending work. The org
extension (`org-extension.ts`) reuses `pi-agentic/shared` (PEP decision, redaction, usage mapping) so
policy parity is by construction. Outcomes: `completed`, `over_budget`, `failed_closed`, `escalated`,
`task_not_running`, `ended_without_completion`, `interrupted`; the bin exits 0 for `completed`, `escalated`,
`over_budget`, 1 for others, 2 on a crash. Model selection: `ORG_DURABLE_PROVIDER` + `ORG_DURABLE_MODEL`.

The `pi-control` daemon launches durable workers only if `startControlPlane` is given `workerMode: "durable"`
programmatically; the daemon's env config does not select it (see [CONFIGURATION.md](CONFIGURATION.md)).

## How to add things

### A new tool grant kind

Grants are strings parsed in `packages/core/src/grants.ts`. For a new kind `foo:<x>`:

1. Add the variant to the `Grant` union; handle it in `parseGrant` and `formatGrant`.
2. Define its narrowing in `grantCovered` (the `switch` is exhaustive, so the compiler flags it); this is what
   makes `delegate`/task grants unable to widen authority.
3. If it gates tool calls, enforce it in `decide` (`policy.ts`) and feed the needed resolved facts through
   `ToolRequest`; resolve anything environment-dependent (paths, hosts) in the extension's `policy-hook.ts`, never
   in core.
4. Update `renderOrgContext` only if the display needs it (it uses `formatGrant`), and the grammar table in the
   [User Guide](USER_GUIDE.md#grants).
5. Tests: `packages/core/test/grants.test.ts` (parse, round-trip, narrowing), `policy.test.ts`
   (deny by default), plus an extension test through `decideToolCall`.

`mcp:` is enforced in `decide` (namespaced `mcp__<server>__<tool>` names, plus `ToolRequest.mcpServers` for the MCP
resource tools, filled by `mcpResourceServers` in `policy-hook.ts`). `host:` has no tool mapping; it only decides
whether bwrap shares the network (`buildBwrapCommand`), and per-host filtering is not enforced in-process.

### A new Pi tool for agents

1. Register it in a new `installOrgXxx(pi, runtime)` in `packages/extension/src` (copy the guard
   `if (!runtime.enabled) return;` and fail closed when `runtime.client` is null), and call it from `index.ts`.
2. If the tool talks to the control plane, add the verb to the `ControlClient` interface and both clients, an RPC
   method in `protocol.ts` / `ControlServer.handleRequest` (identity from the session, never the request) and the
   store method in `store-control.ts`. Audit every mutation with `store.append`.
3. If it needs no grant (like the `org_*` tools) add it to the PEP's `DEFAULT_FREE`; otherwise it is
   default-deny and operators grant it with `tool:<name>`.
4. Mirror it in `packages/durable/src/org-extension.ts` if durable workers should have it.

### A new operator CLI command

Add `packages/cli/src/<name>.ts` exporting `run<Name>(inbox, argv) → { lines, exitCode }` over a narrow interface
(so tests pass a fake), register it in `main.ts`'s command check and add a method to `AdminClient` plus an RPC
method if it needs one. See `approvals.ts` and `notifications.ts`.

### A new package

Add `packages/<name>` with `package.json` (copy an existing `exports` block with the `development` condition and
`files`), `tsconfig.json`, `src/index.ts`, `test/`, a README, and the LICENSE; add it to the root `workspaces` and
`tsconfig.json` references. Publish order is derived from the dependency graph (`scripts/workspace-packages.ts`),
so keep it acyclic.

## Testing conventions

- Runner: `node:test` + `node:assert/strict`; tests are `packages/<pkg>/test/*.test.ts`, run directly from `.ts`.
- Pure logic (core) is tested without I/O. Store tests build a real `ControlStore` on a temp `control.db`
  (`mkdtempSync(join(tmpdir(), "agentic-pi-..."))`), with an **injected `clock`** and a deterministic `genId`
  (see `packages/control-plane/test/lifecycle.test.ts`); advance the fake clock instead of sleeping.
- Extension hooks are tested against a fake `pi` (`HookMap`, `RegisterToolSpec` from `pi-api.ts`) and a real
  `ControlServer`/`LocalControlClient`; `ext-runtime.test.ts` covers the bootstrap/fail-closed paths.
- Unit tests clean up their temp dirs. Anything that scripts the real `pi` binary (`smoke-pi-ext.ts`,
  `simulate-org.ts`, `release-check.ts`) keeps its state under the repo's `./.tmp` (git-ignored) and needs no keys.
- Security-relevant code gets a negative test first: a path that must be denied, a secret that must be redacted,
  a forged `hello` that must be rejected.
- `npm run check` must pass before a change is done; run the smoke scripts when touching hooks, bootstrap, the
  dispatcher or deploy output.

## Releasing

All seven packages share one version and pin each other exactly. A release is one command, run from a clean,
up-to-date `main` with `npm login` and `gh auth login` done:

```sh
pnpm run publish minor --dry-run   # everything except commit/tag/push/publish; restores the bumped files
pnpm run publish minor             # or patch | major | X.Y.Z
pnpm run publish                   # no version: resume a partially published current version
```

(`npm run publish -- minor` is the same. Bare `pnpm publish` is pnpm's built-in command and refuses the private
root package, so the script is always invoked through `run`.)

What `scripts/publish.ts` does, failing closed at each step:

1. **Preflight**: branch `main`, clean tree, not behind `origin/main`, all packages on one version, npm and gh
   logged in, tag `vX.Y.Z` unused, and `CHANGELOG.md` has `## [X.Y.Z]` or a non-empty `## [Unreleased]`.
2. **Bump**: every `version` and every inter-package pin to `X.Y.Z`, `## [Unreleased]` → `## [X.Y.Z] - <date>`,
   `package-lock.json` (`--package-lock-only`; it refuses registry copies nested under `packages/*/node_modules`).
3. **Gates**: `npm run check`, `smoke:pi`, `simulate:org`, `release:check`.
4. **Git**: commit `release: vX.Y.Z`, annotated tag `vX.Y.Z` (message = the changelog section), push `main` and the
   tag. GitHub push protection runs here, before anything reaches npm.
5. **npm**: `npm publish` per package in dependency order, skipping versions already on the registry. With 2FA,
   npm prints a browser approval link per publish (tick "skip for 5 minutes" to approve once), or pass
   `--otp <code>`.
6. **GitHub Release** `vX.Y.Z` with the changelog section as notes.
7. **Verify**: waits (up to 10 min; fresh versions can sit in "being processed") until every `package@X.Y.Z` is on
   the registry with the same shasum as the local pack.

A failure before the commit restores the bumped files. After the commit, fix the cause and re-run
`pnpm run publish` with no version: the tagged commit skips the gates and already-published packages are skipped.

## Workflow: beads and GitNexus

- **Beads** (`bd`) tracks all work; do not keep TODO lists in markdown. `bd ready` to find work, `bd show <id>`,
  `bd update <id> --claim` to take it, `bd close <id>` when done. See [AGENTS.md](../AGENTS.md).
- **GitNexus** indexes the repo for code traversal. Use the CLI before editing a symbol and before committing:
  `node .gitnexus/run.cjs query "concept" --repo .`, `node .gitnexus/run.cjs context <symbol> --repo .`,
  `node .gitnexus/run.cjs impact <symbol> --direction upstream --repo .`, and
  `node .gitnexus/run.cjs detect-changes --scope all --repo .`. Re-index with
  `node .gitnexus/run.cjs analyze --index-only`. An empty caller set is not proof a symbol is unused.
- Keep other people's uncommitted work; do not commit unless asked.
