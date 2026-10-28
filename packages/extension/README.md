# pi-agentic

The loadable [Pi](https://pi.dev) extension of agentic-pi — an agentic org on Pi 1.4.0. It turns a Pi session into
a governed **org unit**: every tool call is checked against the unit's grants (default deny) and audited, secrets
are redacted from results, usage is metered against the unit's budget, and the agent gets tools to delegate,
complete and escalate work through the org control plane.

## What it registers

| Hook / registration | What it does |
|---|---|
| `tool_call` | Policy enforcement: tool must be granted, `read`/`grep`/`find`/`ls`/`write`/`edit` paths are resolved to real paths and matched against `path:` grants, every decision is audited (audit failure blocks), `bash` is rewritten to run under bubblewrap (or blocked) |
| `tool_result` | Redacts declared `secrets` values, `auth.json` values and credential-looking text, including structured content |
| `turn_start` / `turn_end` | Refreshes the control-plane snapshot; meters assistant-message usage and aborts the session when over budget (an escalation is opened) |
| `before_agent_start` | Injects the unit's identity, effective grants, remaining budget and current task; delivers unread notifications once |
| `project_trust` | Trusts a directory only if it is inside the manifest's `trust` list |
| Tools `org_delegate`, `org_complete`, `org_escalate` | Delegate work to a subordinate unit, submit the task artifact to its gates, ask a human |
| Command `/approvals` | `/approvals`, `/approvals approve <id> [choice]`, `/approvals deny <id> [choice]` for the unit owner's inbox |

## Install

```sh
pi install npm:pi-agentic
```

For a deployed unit, install it into **that unit's own agent dir** (personal scope, so `project_trust` works):

```sh
PI_CODING_AGENT_DIR=/var/lib/org-units/eng/agent-dir pi install npm:pi-agentic
```

The `pi-agentic-*` libraries it imports are ordinary npm `dependencies` installed alongside it. It imports no Pi
host package at runtime, so it declares no `peerDependencies`.

## Configuration

It **fails closed**: without org configuration every tool call is blocked. A worker needs `ORG_UNIT_ID`,
`ORG_CONTROL_SOCKET` (its own unit socket), `ORG_UNIT_MANIFEST` (a root-owned `unit.json` for that unit) and, per
task, `ORG_TASK_ID`; the dispatcher sets these. For local development set `AGENTIC_PI_DEV=1` (stays inert outside an
org; `ORG_UNIT_ID` + `ORG_CONTROL_DB` use an in-process client):

```sh
AGENTIC_PI_DEV=1 pi -e packages/extension/src/index.ts   # from an agentic-pi checkout
```

`ORG_BWRAP=1`/`ORG_BWRAP_BIN` route `bash` through bubblewrap; `AGENTIC_PI_UNSANDBOXED_BASH=1` explicitly allows
`bash` without it. Every variable is listed in `docs/CONFIGURATION.md` of the agentic-pi repository.

## Library entry

`pi-agentic/shared` exports the host-neutral pieces (PEP decision, redaction, usage mapping, manifest
loading) that `pi-agentic-durable` reuses for policy parity.

Requires Node >= 24. License: MIT.
