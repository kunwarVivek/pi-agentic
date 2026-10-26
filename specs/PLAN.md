# agentic-pi: delivery plan

Each slice is vertical: it has code, tests and a demo. Slice N+1 starts only after slice N passes `npm run check`.

| Slice | Scope | Exit criteria |
|---|---|---|
| **S0 Scaffold** | Package layout, tsconfig, `node:test`, lint scripts, docs | `npm run check` is green |
| **S1 Pure core** | `manifest` (validate unit.json), `grants` (parse, subset, path match), `policy` PDP, `audit` hash chain, `budget` math, `gates` (schema→rules) | Unit tests cover deny-by-default, narrowing, chain tamper detection |
| **S2 Control store** | `control.db` schema on `node:sqlite`, `ControlStore` (units, tasks, artifacts, approvals, budgets, audit), delegation validation FR3, completion FR4, escalation FR5 | Integration tests on a temp DB with a fake clock |
| **S3 Pi extensions** | `org-policy` (tool_call/tool_result), `org-delegate` tools, `org-context`, `org-trust`, `org-budget` | Extension loads in `pi -e`; hook unit tests with a fake `pi` |
| **S4 Control-plane RPC + dispatcher** | Unix-socket JSON-lines server, peer auth (uid on Linux, token in dev), dispatcher spawning `pi --mode json` per unit | E2E: CEO delegates to sales, sales completes, gate passes, CEO receives the artifact |
| **S5 Lifecycle + scheduler** | TTL, retirement, approval expiry, eval-gated deprecation | Tests with a fake clock |
| **S6 Hardening** | systemd units with a Unix user per unit, bubblewrap/Gondolin for bash, audit anchor export | Linux VM smoke test |
| **S7 Human inbox** | `org approvals` CLI + `/approvals` Pi command; Slack or web later | Approve and deny round trip |

Done: S0 + S1 (17 tests). Next: S2 control store.
