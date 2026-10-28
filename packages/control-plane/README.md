# pi-agentic-control-plane

The stateful host side of agentic-pi: the **single writer of `control.db`** (SQLite, WAL,
`node:sqlite`), the JSON-lines RPC server workers call, peer authentication, the dispatcher that starts unit
workers, the scheduler (lifecycle transitions, approval expiry, dispatch), and the client libraries.

## What it exports

| Area | Exports |
|---|---|
| Store | `ControlStore`: units, tasks, artifacts, approvals, budgets, notifications, evals and the hash-chained audit log; `addUnit`, `delegate`, `completeTask`, `escalate`, `resolveApproval`, `meter`, `sweepLifecycle`, `exportAnchor`/`verifyAnchor`, `verifyAudit`. Time (`clock`) and ids (`genId`) are injectable |
| Protocol and server | `PROTOCOL_VERSION`, `LineDecoder`, `encodeLine`, `ControlServer` (shared socket + one socket per unit), `PeerRegistry`, `authenticate` |
| Orchestration | `Dispatcher`, `Scheduler`, `startControlPlane(options)`, spawners `createSystemdSpawner` / `createUidSpawner` / `createDevSpawner` |
| Clients | `ControlClient` interface, `LocalControlClient` (in-process, dev only), `SocketControlClient` (what workers use), `AdminClient` (operator, admin token) |
| Config | `resolveUnitConfig(env)` and the `ENV_*` constants |

## The `pi-control` daemon

`pi-control` (bin) runs `startControlPlane` from the environment:

| Variable | Meaning |
|---|---|
| `ORG_CONTROL_DB`, `ORG_CONTROL_SOCKET` | required: database path and shared socket |
| `ORG_UNIT_SOCKET_DIR` | required unless `ORG_SPAWNER=dev`: one `<id>.sock` per unit |
| `ORG_SPAWNER` | `systemd` (default), `uid`, or `dev` (needs `AGENTIC_PI_DEV=1`) |
| `ORG_SWEEP_INTERVAL_MS` | scheduler interval, default 60000 |
| `ORG_ADMIN_TOKEN_FILE` | write an operator admin token here (mode 0600) for the `org` CLI |
| `ORG_MANIFEST_DIR`, `ORG_WORKSPACE_ROOT`, `ORG_UNITS_DIR`, `ORG_UNIT_ENV_DIR`, `ORG_BWRAP_BIN`, `ORG_PI_CLI`, `ORG_NODE_BIN` | optional paths and binaries |

The full reference is `docs/CONFIGURATION.md` in the agentic-pi repository.

## Example

```ts
import { ControlStore } from "pi-agentic-control-plane";
import { parseManifest } from "pi-agentic-core";

const store = new ControlStore("/var/lib/org/control.db");
store.addUnit(parseManifest({ id: "ceo", path: "ceo", parent: null, owner: "ceo@example.com",
  grants: ["tool:read", "delegate:*"], budget: { tokens: 1e6, costUsd: 100, wallClockSec: 86400 } }));
console.log(store.verifyAudit()); // { ok: true, count: n }
store.close();
```

```sh
npm install pi-agentic-control-plane
```

Requires Node >= 24. License: MIT.
