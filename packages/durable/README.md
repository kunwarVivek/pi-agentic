# pi-agentic-durable

The durable worker of agentic-pi: runs **one control-plane task in one pi-durable Harness**
with the same org policy, secret redaction, budget metering and `org_delegate` / `org_complete` / `org_escalate`
tools as the Pi extension. A crashed worker restarts and continues the conversation instead of starting over.

It is a standalone worker process, not a Pi extension, so `@earendil-works/pi-durable`, `pi-ai` and `chord` are
regular dependencies.

## How it works

- `control.db` stays authoritative for the task's lifecycle. The pi-durable SQLite file
  `<ORG_DURABLE_DIR>/<taskId>.db` holds only the in-unit conversation and tool-execution state.
- That file is owned by exactly one process at a time, enforced by `<taskId>.lock` (pid + nonce, stale-owner
  takeover, a live owner is refused).
- The goal is submitted with `requestId = taskId` (`taskId:<generation>` after the control plane re-queues the task),
  so a restarted worker finds its submission rather than adding another.
- Policy, redaction and usage mapping are imported from `pi-agentic/shared`, so behaviour matches the Pi
  worker by construction.

## Binary: `agentic-pi-durable-worker`

Launched by the dispatcher in its `durable` mode with the worker environment. It requires:

| Variable | Meaning |
|---|---|
| `ORG_UNIT_ID`, `ORG_TASK_ID`, `ORG_CONTROL_SOCKET` | the unit, the task and the unit's own control socket |
| `ORG_UNIT_MANIFEST` | the unit's root-owned `unit.json` (default `<cwd>/unit.json`) |
| `ORG_DURABLE_DIR` | directory for `<taskId>.db` and `<taskId>.lock` |
| `ORG_DURABLE_PROVIDER`, `ORG_DURABLE_MODEL` | the pi-ai provider and model id; credentials come from that provider's own variables |
| `ORG_WORKSPACE` | optional working directory for the unit's tools (default: the process cwd) |

It prints one JSON result line and exits 0 for outcome `completed`, `escalated` or `over_budget`, 1 for any other
outcome, 2 on a crash.

## Library

`runDurableTask(options)` (the same engine, with injectable `env`, `models`, `model`, `openClient`, `now`,
`signal`), `createOrgExtension`, `acquireTaskLock`, `modelFromEnv`.

```sh
npm install pi-agentic-durable
```

Requires Node >= 24. License: MIT.
