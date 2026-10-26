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
- Using pi-durable in the first slices. It is experimental. ADR-0004 covers this.

## 4. Concepts (ubiquitous language)

- **Unit**: a node in the org chart, with a stable `unit_id`, a `parent_id`, a human `owner`, a directory in the org repo, and an OS user.
- **Manifest**: `unit.json` in the unit directory. It declares grants (tools, path scopes, MCP servers, hosts), budget, model policy, TTL and owner.
- **Grant**: a single allowed capability, for example `tool:read`, `tool:bash`, `path:rw:/var/lib/org/units/sales/workspace/**`, or `delegate:sales/emea`.
- **Task**: a unit of delegated work: `{id, from_unit, to_unit, goal, contract, grants, budget, deadline, status, parent_task}`.
- **Contract**: a JSON Schema plus rules that the result artifact must satisfy.
- **Artifact**: the typed result of a task. It is stored by content hash.
- **Gate**: a check that runs in a fixed order: `schema → rules → judge`, and stops at the first failure.
- **Escalation**: a request for a human decision, routed to the unit owner and then up the tree.
- **Control plane**: the single writer of `control.db`. It owns tasks, the inbox, approvals, budgets and the audit log.
- **PEP / PDP**: the Pi `tool_call` hook is the enforcement point (PEP). The policy module is the decision point (PDP).

## 5. Architecture

```
/srv/org (git, text only)            /var/lib/org (state, per-unit OS users)
  AGENTS.md  .agents/skills/           control/control.db   (owner: pi-control)
  ceo/unit.json AGENTS.md .pi/         units/<id>/agent-dir/auth.json (700)
  sales/unit.json ...                  units/<id>/unit.db  workspace/
  eng/unit.json ...

 ┌──────────── unit worker (pi --mode json, user pi-u-<id>, cwd /srv/org/<path>) ─────────┐
 │ extensions (from the agentic-pi package):                                                   │
 │  org-policy   tool_call  → PDP(grants) → block | allow ; tool_result → redact secrets  │
 │  org-context  before_agent_start → inject unit charter + task context packet           │
 │  org-budget   after_provider_response/turn_end → meter usage; abort when over budget   │
 │  org-delegate registerTool(delegate, complete_task, escalate) → control-plane RPC      │
 │  org-audit    every decision → audit append via control plane                          │
 │  org-trust    project_trust → trust only manifest-listed dirs (headless)               │
 └────────────────────────────────────────────────────────────────────────────────────────┘
                      │ local RPC (unix socket, JSON lines), authenticated by SO_PEERCRED/uid
                      ▼
 ┌──────────── control plane (Node process, user pi-control) ────────────┐
 │ control.db: units, grants, tasks, artifacts, gates, approvals,        │
 │             budgets, audit (hash chain), evals, lifecycle             │
 │ dispatcher: inbox → starts a unit worker (systemd/launchd or spawn as │
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
- **FR2 Policy gate.** Every `tool_call` is checked against the effective grants: unit grants ∩ task grants. Path arguments of `read`, `write`, `edit`, `grep`, `find` and `ls` are resolved with `realpath` and matched against path grants. `bash` is denied unless the unit has the `tool:bash` grant. In v0.1, bash path scope cannot be enforced in-process, so it relies on the OS sandbox (ADR-0002). If the decision throws, the call is blocked.
- **FR3 Delegation.** `delegate(to_unit, goal, contract, grants?, budget?, deadline?)` succeeds only when all of these hold:
  - `to_unit` is a descendant of the caller, or is on the caller's `delegate:` grant list.
  - The requested grants ⊆ the caller's effective grants.
  - The requested budget ≤ the caller's remaining budget. This amount is reserved.
  - Depth ≤ `max_depth` (default 4).
  - Fan-out ≤ `max_children` (default 8).
  - There is no cycle in the `parent_task` chain by unit.
- **FR4 Completion.** `complete_task(task_id, artifact)` stores the artifact by its sha256 and runs the gate chain. If it passes, the task becomes `done` and the parent is notified. If it fails, the task becomes `rejected` with a reason, and it is retried until `max_attempts` (default 2). After that, the task is escalated.
- **FR5 Escalation and approval.** `escalate(task_id, question, options)` creates an approval with a TTL (default 24h). It is routed to the unit owner. If it expires, it moves to the parent's owner. At the root, an expired approval becomes `denied`.
- **FR6 Budget.** Token and cost usage is metered from provider responses. When usage reaches the budget, the current operation is aborted and an escalation is raised. Unused reserved budget goes back to the parent when the task completes.
- **FR7 Audit.** This is an append-only table with `hash = sha256(prev_hash || canonical_json(row))`. `verify()` walks the chain and reports the first bad row.
- **FR8 Lifecycle.**
  - When a manifest's `expires_at` is past, the unit is set to `suspended`.
  - If `last_active` is more than 90 days ago, the unit becomes `retired`.
  - If the eval pass rate drops below `min_eval`, the unit becomes `deprecated`, its new delegations are denied, and the owner is notified.
- **FR9 Secret redaction.** `tool_result` replaces matches of the known secret patterns, plus values from the unit's secret list, with `[REDACTED]`.

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
| An agent forges a delegation | The control plane authenticates the caller by peer uid, not by a claimed `unit_id` | On macOS dev there is no peer-cred check, so dev uses a token file (ADR-0003) |
| The audit log is tampered with | Hash chain plus periodic anchor export off-host | Rewriting the whole chain before an anchor is exported |
| A malicious extension or package (supply chain) | Pin versions; only the org package plus a vetted list | — |

## 9. Open questions

1. Is gt-tree the execution engine inside a unit, or is agentic-pi standalone? The v0.1 answer is standalone, with gt-tree integration later.
2. The approval UI for v0.2: a Slack bot, or pi-web-ui?
3. The department context store: chord services or MCP servers over `dept.db`?
4. Which eval suites does each unit use, and who owns them?
