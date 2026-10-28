# agentic-pi: spec v0.1

Status: draft · Owner: vivek · Target runtime: Pi 1.4.0 (`@earendil-works/pi-coding-agent`), Node ≥ 24 (built-in `node:sqlite`)

## 1. Problem

We want an "agentic org": many Pi agents arranged like an org chart (CEO → departments → teams). Agents do the volume work. Humans handle exceptions and approvals. Every control in the tweet's 7 steps (context layer, harness gates, headless runs, governance, agent-to-agent handoffs with quality gates, step functions) must be built from **Pi + Pi extensions + SQLite**. The only things we do not build are the trust boundary (OS users or VM), inference, the human identity root, and off-host backup.

## 2. Goals

| # | Goal | Measured by |
|---|---|---|
| G1 | Each org unit runs as its own headless Pi worker with its own config, credentials and data. | Unit A cannot read unit B's DB or `auth.json` (OS-level test). |
| G2 | All cross-unit work goes through one control plane (delegation mailbox). No unit spawns another unit's process. | Every delegation has a row in `control.db`. |
| G3 | Every tool call passes a policy gate that defaults to deny. | `tool_call` hook blocks any tool not granted to the unit. Tested. |
| G4 | A unit's authority only narrows going down the tree. | A delegation whose grants are not a subset of the parent's grants is rejected. |
| G5 | Every handoff carries a typed artifact and passes a gate: schema, then rules, then an optional LLM judge. | A bad artifact is rejected and sent back with a reason. |
| G6 | Every decision is audited in a tamper-evident log. | Hash chain verifies. Any edited row breaks verification. |
| G7 | Budgets (tokens, cost, wall-clock) apply per unit and roll up the tree. | Work stops when the budget is used up. Escalation is raised. |
| G8 | Humans approve exceptions from one inbox. | Approval rows have a TTL. If no one answers, the request is denied. |
| G9 | Lifecycle: each agent has a manifest, an owner and a TTL. Agents unused for 90 days are retired. Agents whose eval score drops are deprecated. | Scheduler job does this. Tested with a fake clock. |

## 3. Non-goals (v0.x)

- High availability or multi-host SQLite. There is one writer process per DB.
- A full web UI. The approval inbox is a CLI plus Pi commands first. A web UI comes later.
- Our own model hosting or routing infrastructure. Use Pi providers and virtual models.
- Using pi-durable for control-plane state. pi-durable is adopted only for durable execution inside a unit (ADR-0009, which supersedes ADR-0004); tasks, grants, budgets, gates and audit stay in `control.db`.

## 4. Concepts (ubiquitous language)

- **Unit**: a node in the org chart, with a stable `unit_id`, a `parent_id`, a human `owner`, a directory in the org repo, and an OS user.
- **Manifest**: `unit.json` in the unit directory. It declares grants (tools, path scopes, MCP servers, hosts), budget, model policy, TTL and owner.
- **Grant**: a single allowed capability, for example `tool:read`, `tool:bash`, `path:rw:/var/lib/org-units/sales/workspace/**`, or `delegate:sales/emea`.
- **Task**: a unit of delegated work: `{id, from_unit, to_unit, goal, contract, grants, budget, deadline, status, parent_task}`.
- **Contract**: a JSON Schema plus rules that the result artifact must satisfy.
- **Artifact**: the typed result of a task. It is stored by content hash.
- **Gate**: a check that runs in a fixed order: `schema → rules → judge`, and stops at the first failure.
- **Escalation**: a request for a human decision, routed to the unit owner and then up the tree.
- **Control plane**: the single writer of `control.db`. It owns tasks, the inbox, approvals, budgets and the audit log.
- **PEP / PDP**: the Pi `tool_call` hook is the enforcement point (PEP). The policy module is the decision point (PDP).

## 5. Architecture

```
/srv/org (git, text only)            /var/lib/org (control plane state, owner pi-control)
  AGENTS.md  .agents/skills/           control.db + control.sock (shared admin/dev)
  ceo/unit.json AGENTS.md .pi/       /run/pi-control/<id>.sock  (per-unit sockets)
  sales/unit.json ...                /var/lib/org-units/<id>/ (700, pi-u-<id>)
  eng/unit.json ...                    agent-dir/auth.json  workspace/

 ┌──────────── unit worker (pi --mode json, user pi-u-<id>, cwd /srv/org/<path>) ─────────┐
 │ extensions (from the agentic-pi package):                                                   │
 │  org-policy   tool_call  → PDP(grants) → block | allow ; tool_result → redact secrets  │
 │  org-context  before_agent_start → inject unit charter + task context packet           │
 │  org-budget   turn_end (message.usage) → meter usage; abort when over budget           │
 │  org-delegate registerTool(delegate, complete_task, escalate) → control-plane RPC      │
 │               org-policy also: every decision → record_decision → audit append         │
 │  org-trust    project_trust → trust only manifest-listed dirs (headless)               │
 └────────────────────────────────────────────────────────────────────────────────────────┘
                      │ local RPC (unix socket, JSON lines); one socket per unit, identity = socket (OS perms)
                      ▼
 ┌──────────── control plane (Node process, user pi-control) ────────────┐
 │ control.db: units, grants, tasks, artifacts, gates, approvals,        │
 │             budgets, audit (hash chain), evals, lifecycle             │
 │ dispatcher: inbox → starts a unit worker (systemd, or spawn as        │
 │             that unit's user) → collects artifact → runs gate → routes │
 │ scheduler: TTL expiry, retirement, approval timeouts                  │
 └───────────────────────────────────────────────────────────────────────┘
```

### How each tweet step maps to Pi

| Tweet step | Pi mechanism | agentic-pi component |
|---|---|---|
| 1 Tool adoption | Packages, `pi install`, settings filters | Org package pinned in each unit's `.pi/settings.json` |
| 2 Context layer | `AGENTS.md` inheritance, `.agents/skills`, `before_agent_start`, MCP | `org-context` + per-department `dept.db` (FTS5) behind an MCP or chord service (later) |
| 3 Harness first | `tool_call` / `tool_result` hooks, virtual models | `org-policy`, gates, eval runner |
| 4 Headless | `pi --mode json` / RPC / SDK | Dispatcher runs workers headless; `org-trust` |
| 5 Governance | Manifests, hooks, scheduler | Grants, TTL, lifecycle, audit |
| 6 Agent-to-agent | Custom tools + control plane | `delegate` / `complete_task` + gate chain |
| 7 Step functions | Task graph in SQLite | Tasks with `parent_task`, status machine, escalations |

## 6. Functional requirements

- **FR1 Manifest load.** The `unit.json` file is validated at worker start. If it is not valid, the worker refuses to start (fail closed).
- **FR2 Policy gate.** Every `tool_call` is checked against the effective grants: unit grants ∩ task grants. Path arguments of `read`, `write`, `edit`, `grep`, `find` and `ls` are resolved with `realpath` and matched against path grants. Shell tools (`bash`, `powershell`) are denied unless the unit holds the exact `tool:bash` / `tool:powershell` grant; `tool:*` and other wildcards never cover them. Bash path scope cannot be enforced in-process, so a granted bash call is rewritten in the `tool_call` hook to run under bubblewrap built from the unit's path grants (`ORG_BWRAP=1`, ADR-0002). Without `ORG_BWRAP` the call is blocked (fail closed), unless `AGENTIC_PI_DEV=1` or `AGENTIC_PI_UNSANDBOXED_BASH=1` explicitly allows it. If the decision throws, the call is blocked. Outside the org (no `ORG_UNIT_ID`/control socket) the extension blocks every tool unless `AGENTIC_PI_DEV=1`.
  - **MCP.** Pi 1.4.0 names MCP tools `mcp__<server>__<tool>`. Such a call needs the `tool:` grant and an `mcp:<server>` grant (`*` covers all; `-` and `_` in server names are equivalent, as in Pi). The MCP resource tools (`read_mcp_resource`, `list_mcp_resources`, `list_mcp_resource_templates`) need `mcp:` for their `server` argument, and `mcp:*` when a list call names no server. An MCP name whose server cannot be determined is denied; a name that is ambiguous between two servers needs a grant for each.
  - **Network.** Bash under bubblewrap gets `--unshare-net` unless the unit holds at least one `host:` grant. This is all-or-nothing: per-host filtering is not enforced in-process and needs an egress proxy or firewall outside the sandbox. Pi 1.4.0 has no built-in web/fetch tool, so no tool-call argument is matched against `host:` grants.
- **FR3 Delegation.** `delegate(to_unit, goal, contract, grants?, budget?, deadline?)` succeeds only when all of these hold:
  - `to_unit` is a descendant of the caller (no grant needed), or is covered by one of the caller's `delegate:` grants. A bare `delegate:*` covers descendants only; a lateral or upward target needs an explicit (non-wildcard) `delegate:<unit>` grant.
  - The requested grants ⊆ the caller's effective grants.
  - The requested budget ≤ the caller's remaining budget. This amount is reserved.
  - Depth ≤ `max_depth` (default 4), counted as the number of delegation hops from the root initiator to the new task (a root-initiated delegation is depth 1; the limit is the caller's).
  - Fan-out ≤ `max_children` (default 8).
  - There is no cycle in the `parent_task` chain by unit.
- **FR4 Completion.** `complete_task(task_id, artifact)` stores the artifact by its sha256 and runs the gate chain. If it passes, the task becomes `done`, its reservation is released to the parent, and the delegating unit gets a `task.done` notification. If it fails, the task becomes `rejected` with a reason (and a `task.rejected` notification), then is re-queued as `pending` with its `generation` incremented, until `max_attempts` (default 2, from the delegating unit's limits) failures have been recorded. At that point the task is not re-queued: it becomes `escalated` with an approval whose options are `retry` and `cancel`.
- **FR5 Escalation and approval.** `escalate(task_id, question, options)` creates an approval with a TTL (default 24h). It is routed to the owner of the executing unit, and the approval records that unit as its holder (`holder_unit_id`). If it expires, it climbs one level: the holder becomes the holder's parent unit (tracked by unit id, because owners repeat up the tree) and the TTL restarts. At the root, an expired approval becomes `denied` and the task is cancelled. Approving re-opens the task as `pending`; the choice `extend` also raises an exhausted budget dimension.
- **FR6 Budget.** Token and cost usage is metered from provider responses. When usage reaches the budget, the current operation is aborted and an escalation is raised. Unused reserved budget goes back to the parent when the task completes.
- **FR7 Audit.** This is an append-only table with `hash = sha256(prev_hash || canonical_json(row))`. `verify()` walks the chain and reports the first bad row.
- **FR8 Lifecycle.**
  - When a manifest's `expires_at` is past, the unit is set to `suspended`.
  - If `last_active` is more than 90 days ago, the unit becomes `retired`.
  - If the eval pass rate drops below `min_eval`, the unit becomes `deprecated`, its new delegations are denied, and the owner is notified.
- **FR9 Secret redaction.** `tool_result` replaces matches of the known secret patterns, plus the values of the environment variables named in the manifest's `secrets` list, with `[REDACTED]`. `secrets` holds env var **names** (matching `^[A-Z_][A-Z0-9_]*$`, deduplicated), never the values; the values are read from the worker's environment at start.

## 7. Non-functional requirements

- No runtime dependencies beyond Pi and Node built-ins in the core. TypeBox comes with Pi.
- Every policy and gate path defaults to deny.
- Each SQLite DB uses WAL mode and has a single writer process.
- Pure core (policy, grants, gates, audit, budget math) has no I/O. It is unit-tested with `node:test`.
- A fake clock is injected into everything that depends on time.

## 8. Threat model (summary)

| Threat | Mitigation | Residual |
|---|---|---|
| A prompt-injected agent calls a forbidden tool | Default-deny PEP in `tool_call` | `bash` can escape the in-process checks, so it needs an OS sandbox (ADR-0002) |
| A unit reads another unit's data | Separate OS user and mode-700 state directory per unit | A misconfigured host |
| The CEO pulls raw data from departments | The CEO has `delegate:*` but no data path grants. It sees only artifacts. | Artifacts can carry data, so the gate rules need to check them |
| An agent forges a delegation | Identity is the per-unit socket the worker connects to: `/run/pi-control/<id>.sock`, owner `pi-control`, group `pi-u-<id>`, mode 0660 inside a 0711 directory. A `hello` that claims another unit is rejected. | The shared socket (`/var/lib/org/control.sock`) keeps token auth for dev and admin only; no worker can reach it (ADR-0003) |
| The audit log is tampered with | Hash chain plus periodic anchor export off-host | Rewriting the whole chain before an anchor is exported |
| A malicious extension or package (supply chain) | Pin versions; only the org package plus a vetted list | — |

## 9. Open questions

1. Is gt-tree the execution engine inside a unit, or is agentic-pi standalone? The v0.1 answer is standalone, with gt-tree integration later.
2. The approval UI for v0.2: a Slack bot, or pi-web-ui?
3. The department context store: chord services or MCP servers over `dept.db`?
4. Which eval suites does each unit use, and who owns them?
