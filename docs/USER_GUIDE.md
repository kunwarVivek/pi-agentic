# User Guide

For people who run an agentic-pi org or own one of its units. For installing on a host see
[DEPLOY.md](DEPLOY.md); for every environment variable see [CONFIGURATION.md](CONFIGURATION.md); for the
requirements and threat model see [specs/SPEC.md](../specs/SPEC.md).

## Concepts

| Term | Meaning |
|---|---|
| **Unit** | A node in the org tree: stable `id`, optional `parent`, a human `owner`, a workspace directory `<ORG_WORKSPACE_ROOT>/<path>` and (in production) a dedicated OS user `pi-u-<id>`. Each task runs in a headless Pi worker acting as that unit. |
| **Manifest** | The unit's `unit.json`: grants, budget, limits, expiry, `minEval`, `secrets`, `trust`. See [the reference](#unitjson-reference). |
| **Grant** | One allowed capability as a string: `tool:read`, `path:rw:/srv/org/sales/**`, `delegate:sales/*`, `mcp:crm`, `host:api.example.com`. Anything not granted is denied. |
| **Task** | A unit of delegated work: goal, contract, optional narrowed grants, a budget, a status. Statuses: `pending`, `running`, `done`, `rejected`, `escalated`, `cancelled`. |
| **Contract** | `{ schema, rules?, judge? }` the task's result artifact must satisfy. |
| **Artifact** | The typed result of a task, stored by its sha256. |
| **Gate** | The check on an artifact: `schema`, then `rules`, then an optional `judge`; the first failure stops it. |
| **Escalation** | A question with options raised for a human, routed to the unit's owner. Produces an **approval**. |
| **Control plane** | The single process (`pi-control`) that owns `control.db` and does all writes: tasks, approvals, budgets, audit. |
| **Audit chain** | An append-only log where each row's hash covers the previous row's hash; editing any row breaks verification. |

Authority only narrows going down the tree: a delegation can never carry grants or budget its sender does not
hold ([ADR-0005](../specs/adr/0005-authority-narrows-gates-ordered.md)).

## Registering units

A unit exists once it has a row in `control.db`. Author one `unit.json` per unit in the org repo, at
`<org-root>/<unit path>/unit.json` (the `path` field must equal that directory), then register them with
`org units sync`:

```sh
# against the running control plane (needs ORG_CONTROL_SOCKET and ORG_ADMIN_TOKEN_FILE, see CONFIGURATION.md)
org units sync /srv/org
# first-time setup or maintenance with the daemon STOPPED: write control.db directly (run as the pi-control user)
org units sync /srv/org --db /var/lib/org/control.db
```

Every `unit.json` under the org root is validated with `parseManifest` first; if any is invalid nothing is
synced. Then, per unit:

- **New** manifests are added (audited `unit.add`); parents are added before children.
- **Existing** units get their `owner`, `parent`, `grants`, `budget`, `limits`, `expiresAt` and `minEval`
  updated to match the manifest (audited `unit.update`, with the before/after of each changed field). Status and
  usage are untouched. Re-running with no changes writes nothing.
- **Refused** (exit code 1, the unit is left as it was): a parent change that would create a cycle or names an
  unknown unit, a `path` change, a duplicate id.
- **Never deleted.** A unit in `control.db` with no manifest is only reported (`warning: no manifest for ...`);
  suspend or retire it deliberately.

The live form is admin-only (`sync_units` RPC) and opens the per-unit sockets of newly added units; a unit whose
`pi-u-<id>` group does not exist yet is audited as `unit.socket_error`. `--db` must not be used while the daemon
is running: the daemon is the single writer of `control.db`.

What lives where matters:

- `grants`, `budget`, `limits`, `expiresAt`, `minEval`, `owner`, `parent`, `path` are stored in the `control.db`
  row, and **that row is what is enforced** at run time. Editing `unit.json` later does not change them.
- `secrets` and `trust` are not stored in the database. The worker reads them from the unit's `unit.json` at
  start, from the root-owned copy that `org-render` installs (see [DEPLOY.md](DEPLOY.md)).

## `unit.json` reference

Parsing is fail closed: unknown fields, wrong types and malformed grants are all errors, and a worker whose
manifest is invalid, unreadable or for a different unit id than `ORG_UNIT_ID` blocks every tool call.

```json
{
  "id": "sales-emea",
  "path": "sales/emea",
  "parent": "sales",
  "owner": "emea-lead@example.com",
  "grants": [
    "tool:read",
    "tool:grep",
    "tool:write",
    "path:rw:/srv/org/sales/emea/**",
    "path:r:/srv/org/shared/**",
    "delegate:sales/emea/*",
    "host:api.example.com"
  ],
  "budget": { "tokens": 500000, "costUsd": 20, "wallClockSec": 7200 },
  "limits": { "maxDepth": 4, "maxChildren": 8, "maxAttempts": 2 },
  "expiresAt": "2027-06-30T00:00:00Z",
  "minEval": 0.8,
  "secrets": ["CRM_API_KEY"],
  "trust": ["/srv/org/sales/emea"]
}
```

| Field | Required | Type and rules | Default |
|---|---|---|---|
| `id` | yes | String matching `^[a-z0-9][a-z0-9-]*$`, at most 24 characters (`pi-u-<id>` must fit the 32-character Linux username limit). | |
| `path` | yes | Org path `a/b/c` of lowercase `[a-z0-9-]` segments. The unit's workspace is `<ORG_WORKSPACE_ROOT>/<path>`. | |
| `parent` | yes | A unit id, or `null` for the root. | |
| `owner` | yes | Non-empty string identifying the human who receives this unit's approvals and notifications (an email, a handle; it is an opaque key). | |
| `grants` | yes | Array of grant strings, see [Grants](#grants). May be empty (the unit can then do nothing). | |
| `budget` | yes | `{ tokens, costUsd, wallClockSec }`, each a finite number ≥ 0. The unit's lifetime ceiling; see [Budgets](#budgets-and-escalations). | |
| `limits.maxDepth` | no | Positive integer: how many delegation hops a chain started under this unit may have. | 4 |
| `limits.maxChildren` | no | Positive integer: open child tasks this unit may have under one task. | 8 |
| `limits.maxAttempts` | no | Positive integer: failed gate attempts before a task delegated by this unit escalates instead of being retried. | 2 |
| `expiresAt` | no | ISO date/time string, or `null`. Once past, the next scheduler sweep sets the unit to `suspended`. | `null` (never) |
| `minEval` | no | Number in `[0, 1]`, or `null`. If the unit's latest eval pass rate falls below it, the unit becomes `deprecated`. | `null` (no check) |
| `secrets` | no | Array of environment variable **names** (`^[A-Z_][A-Z0-9_]*$`, de-duplicated). Never put values here. | `[]` |
| `trust` | no | Array of absolute directories whose project resources (`.pi/`, `.agents/`) Pi may load. No wildcards, no `..`, not `/`, no trailing slash, already normalized. | `[]` |

Field notes:

- **`limits`** are read from the unit that **delegates**: `maxDepth` and `maxChildren` cap that unit's
  outgoing delegations, and `maxAttempts` counts gate rejections on tasks it delegated. The depth of a
  root-initiated delegation is 1; with `maxDepth: 4`, depth 4 is allowed and depth 5 is refused.
- **`secrets`** names variables the worker holds (loaded from the root-owned `secrets.env`, see DEPLOY.md). Their
  values are replaced with `[REDACTED]` in every tool result, along with every string value found in the
  unit's Pi `auth.json` (values of 8+ characters) and anything that looks like a credential.
- **`trust`** is the only way a project directory becomes trusted: a headless worker cannot answer a trust
  prompt, so the extension answers `project_trust` itself, saying yes only when the working directory is inside
  a listed directory. Path grants never imply trust, because a unit that can write its workspace could plant
  `.pi/extensions` there.
- In a deployment the manifest the worker reads must not sit inside any path the unit can write: a unit whose
  manifest is inside one of its own `path:rw:` grants is refused at start, since it could otherwise edit its own
  `secrets` and `trust`.

## Grants

Grammar:

| Form | Example | Meaning |
|---|---|---|
| `tool:<name>` | `tool:read`, `tool:*` | Allow a Pi tool. Names are `[A-Za-z0-9_.*-]`. `tool:*` allows every tool **except** `bash` and `powershell`, which need their own exact grant. |
| `path:<r\|rw>:<absolute pattern>` | `path:rw:/srv/org/sales/**` | Allow file access. `rw` includes read. Pattern is exactly `/a/b`, `/a/b/*` (direct children) or `/a/b/**` (`/a/b` and everything under it). |
| `delegate:<unit path>` | `delegate:sales/emea`, `delegate:sales/*`, `delegate:*` | Allow delegating to a unit outside your own subtree, or to a unit path or subtree. |
| `mcp:<server>` | `mcp:crm` | An MCP server name (`*` covers all). Every MCP tool (`mcp__<server>__<tool>`) and MCP resource tool needs it in addition to its `tool:` grant. |
| `host:<hostname>` | `host:api.example.com` | A network host (lower-cased; `*` covers all). Holding any `host:` grant lets sandboxed `bash` use the network; see rule 8 for what that does and does not enforce. |

Rules the policy applies on every tool call (default deny):

1. The tool must be covered by a `tool:` grant. The three org tools (`org_delegate`, `org_complete`,
   `org_escalate`) need no grant; their authority is checked by the control plane.
2. For `read`, `grep`, `find`, `ls` (read) and `write`, `edit` (write), the path argument is resolved to a real
   path (symlinks followed, `~` and `@` spellings normalized, relative paths resolved against the working
   directory; `grep`/`find`/`ls` with no path mean the working directory) and must match a `path:` grant. A
   `read` needs `r` or `rw`; a write needs `rw`.
3. Path patterns are deliberately narrow: root-level wildcards (`/`, `/*`, `/**`), mid-segment globs (`/etc*`) and
   `..` are rejected when the grant is parsed.
4. In a deployed worker, writes into `<cwd>/.pi` and `<cwd>/.agents` (and the same directories of any `trust`
   dir) are refused, so a unit cannot plant extensions or skills for later sessions.
5. A `bash` call needs the exact `tool:bash` grant **and** the OS sandbox: it is rewritten to run under
   bubblewrap built from the unit's path grants. Without the sandbox it is blocked unless `AGENTIC_PI_DEV=1` or
   `AGENTIC_PI_UNSANDBOXED_BASH=1` is set. `powershell` cannot be sandboxed and is always blocked outside those
   escape hatches. Never grant `tool:bash` on a host without the sandbox ([DEPLOY.md](DEPLOY.md)).
6. If the decision throws, or the audit write fails, the call is blocked.
7. **MCP.** Pi 1.4.0 names MCP tools `mcp__<server>__<tool>` (every character other than letters, digits and `_`
   becomes `_`, so `mcp:my-crm` matches `mcp__my_crm__…`). Such a call needs the `tool:` grant **and** `mcp:<server>`.
   `read_mcp_resource`, `list_mcp_resources` and `list_mcp_resource_templates` use their `server` argument; a list
   call without `server` reaches every server and needs `mcp:*`. A name whose server cannot be read is denied, and
   a name that could belong to two servers (tool names containing `__`) needs a grant for each. Codemode scripts
   run their nested MCP calls through the same policy.
8. **Network.** Sandboxed `bash` has no network (`--unshare-net`) unless the unit holds at least one `host:` grant.
   That is all-or-nothing: **which** hosts a command may reach is not enforced in-process. Restrict hosts with an
   egress proxy or firewall outside the sandbox. Pi 1.4.0 ships no built-in web/fetch tool (its built-ins are
   `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`), so no tool-call argument is checked against `host:`.

### Narrowing

A grant is covered by a parent grant when it is the same grant or strictly narrower: `path:r:/srv/a/b` is covered
by `path:rw:/srv/a/**`, but `path:rw:` is never covered by `path:r:`; `delegate:sales/emea` is covered by
`delegate:sales/*`; `tool:read` by `tool:*`; `tool:bash` only by `tool:bash`. A task's **effective grants** are the
unit's grants intersected with the grants the delegator attached to that task (no task grants means the unit's
grants). A grant with no overlap is dropped.

## Delegating work

Inside a worker, the agent has three tools:

| Tool | Purpose |
|---|---|
| `org_delegate` | `toUnit`, `goal`, `contract`, `budget`, optional `grants`. Returns the new task id, or `delegation denied (<code>): <reason>`. |
| `org_complete` | `artifact`. Submits the current task's result to its gates. |
| `org_escalate` | `question`, `options`. Opens an approval and parks the task until a human answers. |

`org_delegate` succeeds only when all of these hold; the code in parentheses is what a denial reports:

- Both units exist and are `active` (`unknown_from`, `unknown_to`, `from_inactive`, `to_inactive`); not to self (`self`).
- The target is a **descendant** of the caller, or is covered by one of the caller's `delegate:` grants
  (`not_authorized`). A bare `delegate:*` covers descendants only: a lateral or upward target needs an explicit,
  non-wildcard grant (`lateral_needs_explicit`).
- Requested grants are a subset of the caller's effective grants (`widening`).
- The requested budget fits the caller's remaining budget (`budget`) and the target unit's own ceiling
  (`budget_target`); it is reserved against the caller until the task settles.
- Depth within the caller's `maxDepth` (`depth`), open children within `maxChildren` (`fanout`), and the target is
  not already in the task chain (`cycle`).
- The budget has finite, non-negative numbers (`bad_budget`).
- A contract with `judge: true` needs a judge configured on the control store; the stock `pi-control` daemon has
  none, so such delegations are refused with `judge_unavailable`.

### Contracts and gates

A contract is `{ "schema": {...}, "rules": {...}, "judge": false }`.

- `schema` is a JSON Schema subset: `type`, `properties`, `required`, `additionalProperties` (only `false` has an
  effect), `items`, `enum`, `const`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`,
  `pattern`, plus `description`, `title`, `$schema`. Any other keyword is rejected, so a contract never
  silently under-validates.
- `rules` are optional: `forbiddenKeys` (keys that may not appear anywhere in the artifact), `forbiddenPatterns`
  (regex sources that may not match the canonical JSON text; unsafe or over-long inputs fail closed) and
  `maxBytes`.
- `judge: true` adds an LLM/judge stage after rules.

Outcome of `org_complete`: gates pass → task `done`, reservation released to the parent, parent gets a
`task.done` notification. Gates fail → task `rejected` with the reason, the delegator gets `task.rejected`, and
the task is re-queued `pending` for another attempt. After the delegator's `maxAttempts` failures the task
becomes `escalated` with an approval whose options are `retry` and `cancel`.

## Approvals inbox

An approval is created by `org_escalate`, by a budget breach, by repeated gate failure, or when a worker could
not be started. It is routed to the **owner** of the unit executing the task and expires after **24 hours**.
If nobody answers, it climbs one level: the holder becomes the holder's parent unit (so its owner), with a fresh
24 hours. At the root, an expired approval becomes `denied` and the task is cancelled: **no answer means no**.
An approval past its TTL can no longer be resolved; the next scheduler sweep re-routes or denies it.

Resolving an approval drives the task:

| Decision | Effect on the escalated task |
|---|---|
| approve | Re-queued as `pending` for another attempt. |
| approve with choice `extend` | Doubles the task budget on each exhausted dimension (reserving the extra from the delegator's remaining budget), then re-queues. Refused if nothing is exhausted, the unit's own ceiling is exhausted, or the parent cannot cover it. |
| approve with choice `cancel`, or deny | Cancelled; its budget reservation returns to the delegator, who gets a `task.rejected` notification. |

`choice` is optional but, when given, must be one of the approval's listed options.

### On the control host: `org`

The `org` command (package `pi-agentic-cli`) talks to the control plane over its shared socket with the operator
admin token. It needs `ORG_CONTROL_SOCKET` and `ORG_ADMIN_TOKEN_FILE` (or `ORG_ADMIN_TOKEN`); the control plane
writes the token file at start when `ORG_ADMIN_TOKEN_FILE` is set for `pi-control` ([DEPLOY.md](DEPLOY.md)).

```sh
export ORG_CONTROL_SOCKET=/var/lib/org/control.sock
export ORG_ADMIN_TOKEN_FILE=/var/lib/org/admin.token

org approvals list                     # open approvals: id, task, owner, question, options, expiry
org approvals approve <id> [choice]
org approvals deny <id> [choice]

org notifications                      # unacknowledged owner notifications (same as `list`)
org notifications ack <id>
```

The admin token sees every owner's inbox; keep the file mode 600 and readable only by the operator.

### Inside Pi: `/approvals`

In a unit's Pi session the extension registers `/approvals`. It lists and resolves only the approvals routed to
that unit's owner:

```text
/approvals                         list open approvals for this unit's owner
/approvals approve <id> [choice]
/approvals deny <id> [choice]
```

## Notifications

The control plane queues a notification, with the addressed unit's owner recorded on it, for:

| Kind | When | Addressed to |
|---|---|---|
| `task.done` | A delegated task passed its gates. | The delegating unit |
| `task.rejected` | A gate failed, or an approval cancelled/denied the task. | The delegating unit |
| `task.escalated` | A delegated task raised an approval. | The delegating unit |
| `unit.lifecycle` | A unit was suspended, retired or deprecated. | The unit (and so its owner) |

Two ways to read them:

- **Owner inbox** (works when the unit has no live session): `org notifications` and `org notifications ack <id>`.
- **In a session**: unread notifications for the unit are injected once at the start of the agent's next turn as a
  user-visible `org_notifications` message, then acknowledged. Free-form text from other units appears only in a
  quoted, length-capped `untrusted` field, never as instructions.

## Budgets and escalations

`budget` has three dimensions: `tokens`, `costUsd`, `wallClockSec`. It is a unit's lifetime ceiling.

- A delegation **reserves** its budget against the delegator; the reservation returns to the parent when the
  task settles (unused part included).
- After every model turn the extension reports the assistant message's usage to the control plane: tokens (the
  provider's total, else input + output + cache), cost (`usage.cost.total`) and the turn's wall-clock seconds.
  Usage is added to the task, to every still-open ancestor task, and to the executing unit's own usage.
- A dimension is **exhausted** once usage is above zero and has reached its limit. When a task exceeds its
  own budget, its unit's ceiling, or pushes a delegator past its ceiling, the control plane opens an escalation
  ("budget exhausted on ...") with options `extend` and `cancel` (only `cancel` when the limit hit is an
  ancestor's ceiling) and the worker session is aborted.
- A turn that cannot be metered (no usage on the message, or the control plane is unreachable) aborts the
  session: the worker fails closed rather than run unmetered.

## Lifecycle

Every unit is `active`, `suspended`, `deprecated` or `retired`. Only `active` units can delegate or be delegated
to, and only `active` units get workers. The scheduler sweep (every `ORG_SWEEP_INTERVAL_MS`, default 60 s) applies,
in this order, to each active unit:

1. `expiresAt` in the past → **suspended** (reason `expired`).
2. No activity for more than **90 days** (measured from last activity, falling back to creation) and no
   pending, running or escalated task → **retired** (reason `idle`).
3. `minEval` set and the latest recorded eval pass rate below it → **deprecated** (reason `low_eval`).

Each transition is audited and sends the unit a `unit.lifecycle` notification. A unit with no eval runs is
never deprecated.

Eval runs come from `pi-agentic-evals` ([package README](../packages/evals/README.md)): `runAndRecord` grades a
suite and records `passed`/`total` through the control store.

## Secrets, trust and audit

- Put secret **values** only in the root-owned `secrets.env` of the unit; list the **names** in `secrets`.
- Every allow/deny decision, delegation, completion, escalation, approval, metering step and lifecycle change is
  appended to the audit chain in `control.db`. `ControlStore.verifyAudit()` walks the chain and reports the first
  bad row. To detect a rebuilt chain, export an anchor off-host periodically and check it with
  `verifyAnchor` ([DEPLOY.md](DEPLOY.md#audit-anchor-off-host-tamper-evidence)).
