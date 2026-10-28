# Configuration reference

Every environment variable agentic-pi reads, derived from the source. Configuration is environment-only. Values
marked "worker" are set **for** a unit worker by the dispatcher or the rendered systemd unit, not by hand. For the
deployment context see [DEPLOY.md](DEPLOY.md); for the manifest file see
[USER_GUIDE.md](USER_GUIDE.md#unitjson-reference).

`PI_CODING_AGENT_DIR` is Pi's own variable (a unit's agent dir); agentic-pi sets it for workers and reads
`<dir>/auth.json` to redact its values from tool results.

## Control plane: `pi-control` daemon

Read by `packages/control-plane/src/control-plane.ts` (`configFromEnv`). Missing required values abort start.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `ORG_CONTROL_DB` | yes | | Path of `control.db`, the SQLite file only this process writes. |
| `ORG_CONTROL_SOCKET` | yes | | Shared (admin/dev) Unix socket to listen on. Mode 0600. |
| `ORG_UNIT_SOCKET_DIR` | yes, unless `ORG_SPAWNER=dev` | | Directory of per-unit sockets `<id>.sock` (created 0711). Workers authenticate by which socket they reach. Every unit needs a `pi-u-<id>` group; units without one are skipped and audited as `unit.socket_error`. |
| `ORG_SPAWNER` | no | `systemd` | How workers start: `systemd` (starts `pi-unit@<id>.service` through `systemctl`), `uid` (control plane **as root** spawns as `pi-u-<id>`), `dev` (workers run as the control-plane user with a dev token; requires `AGENTIC_PI_DEV=1`). Any other value aborts start. |
| `ORG_SWEEP_INTERVAL_MS` | no | `60000` | Scheduler sweep interval (lifecycle, approval expiry, dispatch). Must be a positive number. |
| `ORG_ADMIN_TOKEN_FILE` | no | none | When set, a fresh operator admin token is written here (mode 0600) at every start. Without it the admin socket path (`org` CLI) is unavailable. |
| `ORG_MANIFEST_DIR` | no | `/etc/agentic-pi/units` | Root-owned manifest dir: `<dir>/<id>/unit.json` (exported to workers as `ORG_UNIT_MANIFEST`) and `<dir>/<id>/secrets.env`. With the `dev` spawner and this unset, the manifest is `<workspace>/unit.json`. |
| `ORG_WORKSPACE_ROOT` | no | `/srv/org` | Worker working directory root: a unit's cwd is `<root>/<unit path>`. |
| `ORG_UNITS_DIR` | no | none | Per-unit state root; when set, the unit's `PI_CODING_AGENT_DIR` is `<dir>/<id>/agent-dir`. |
| `ORG_UNIT_ENV_DIR` | no | `<ORG_UNIT_SOCKET_DIR>/env` | Where the systemd spawner writes the per-task EnvironmentFile (mode 0700 dir). |
| `ORG_BWRAP_BIN` | no | none | `bwrap` binary exported to workers of units that hold `tool:bash`. |
| `ORG_PI_CLI` | no | none | Pi's `cli.js` for the `uid` spawner (run as `<node> <cli.js> --mode json`); without it that spawner runs `pi --mode json`. |
| `ORG_NODE_BIN` | no | `/usr/bin/node` | Node binary for the `uid` spawner when `ORG_PI_CLI` is set. |
| `AGENTIC_PI_DEV` | for `dev` spawner | | Must be `1` to construct the `dev` spawner. |
| `ORG_WORKER_MODE` | no | `pi` | `pi` or `durable`: which worker the dispatcher launches (`pi-unit@<id>` vs `pi-durable@<id>` units). Any other value aborts start. `org-render` exports it for you when rendering durable units. |
| `ORG_JUDGE` | no | `none` | The only accepted value is `none`: no LLM judge implementation ships with agentic-pi, so a delegation whose contract has `judge: true` is **refused** (`judge_unavailable`) and a `judge` gate fails closed. Any other value aborts start. A judge is code: pass a `JudgeFn` to `ControlStore` when embedding the library. |

## Worker (Pi extension and durable worker)

Set by the dispatcher/systemd for each task; the production environment is an allowlist built from scratch.

| Variable | Read by | Meaning |
|---|---|---|
| `ORG_UNIT_ID` | extension, durable | The unit the worker acts as. Required for governance. |
| `ORG_TASK_ID` | extension, durable | The task being executed (per task, from the EnvironmentFile). Without it the worker has no task to meter, complete or escalate. |
| `ORG_CONTROL_SOCKET` | extension, durable | The worker's **own** unit socket (not the shared one). Required for deployed workers. |
| `ORG_UNIT_MANIFEST` | extension, durable | Absolute path of the unit's `unit.json`. Default `<cwd>/unit.json`. Must be outside every path the unit can write (deployed). |
| `ORG_BWRAP` | extension | `1` routes the granted `bash` tool through bubblewrap. Rendered for units holding `tool:bash`. |
| `ORG_BWRAP_BIN` | extension | `bwrap` binary to use (sandbox default `/usr/bin/bwrap`). |
| `AGENTIC_PI_DEV` | extension, durable, `dev` spawner | `1` = development mode: with no org configuration the extension stays inert instead of blocking; allows the in-process `ORG_CONTROL_DB` client; allows unsandboxed `bash`; skips the "manifest outside writable paths" check. Never set in production. |
| `AGENTIC_PI_UNSANDBOXED_BASH` | extension | `1` explicitly allows a granted `bash` call to run without the OS sandbox. |
| `ORG_CONTROL_DB` | extension (dev only) | Path of `control.db` for the in-process client. Honoured only with `AGENTIC_PI_DEV=1`; never given to production workers. |
| `ORG_UNIT_TOKEN` | extension (dev only) | Dev bearer token for the `hello` handshake on the shared socket; issued by the `dev` spawner only. |
| `ORG_DURABLE_DIR` | durable | **Required** for the durable worker: directory holding `<taskId>.db` (pi-durable storage) and `<taskId>.lock`. Rendered inside the unit's state dir (`<state>/durable`). |
| `ORG_DURABLE_PROVIDER` | durable | **Required.** pi-ai provider id of the model. Provider credentials come from that provider's own variables. |
| `ORG_DURABLE_MODEL` | durable | **Required.** Model id within the provider. |
| `ORG_WORKSPACE` | durable | Optional working directory for the unit's tools (default: the process cwd). |

Behaviour when configuration is missing (extension): no `ORG_UNIT_ID`/`ORG_CONTROL_SOCKET`/`ORG_CONTROL_DB` and no
`AGENTIC_PI_DEV=1` → every tool call is blocked; `ORG_UNIT_ID` without a socket → blocked unless
`AGENTIC_PI_DEV=1` with `ORG_CONTROL_DB`.

## Operator CLI: `org`

Read by `packages/cli/src/main.ts`.

| Variable | Required | Meaning |
|---|---|---|
| `ORG_CONTROL_SOCKET` | yes | The shared control socket (the same path `pi-control` listens on). |
| `ORG_ADMIN_TOKEN_FILE` | one of the two | File holding the admin token (written by `pi-control`). Trimmed on read. |
| `ORG_ADMIN_TOKEN` | one of the two | The token itself; overrides the file. |

`org units sync <org-root>` uses the socket and token above. `org units sync <org-root> --db <control.db>` needs
neither: it opens `control.db` directly (creating it if absent) and is only for use while `pi-control` is stopped.

## Deploy renderer: `org-render <control.db> <out-dir>`

Read by `packages/deploy/src/render.ts`. Unit files go to `<out-dir>`; sysusers/tmpfiles/polkit fragments go under
`ORG_ETC_DIR`; root-owned manifests go to `ORG_MANIFEST_DIR`.

| Variable | Default | Meaning |
|---|---|---|
| `ORG_CONTROL_SOCKET` | `/var/lib/org/control.sock` | Shared socket path written into `pi-control.service`. |
| `ORG_STATE_DIR` | directory of the `control.db` argument | Control-plane writable state dir; workers are denied it. |
| `ORG_UNIT_SOCKET_DIR` | `/run/pi-control` | Per-unit sockets directory (systemd `RuntimeDirectory`). |
| `ORG_UNITS_DIR` | `/var/lib/org-units` | Per-unit state root (`<dir>/<id>`, mode 0700). |
| `ORG_MANIFEST_DIR` | `/etc/agentic-pi/units` | Where root-owned manifests and `secrets.env` live; exported to `pi-control.service`. |
| `ORG_WORKSPACE_ROOT` | `/srv/org` | Worker cwd root; also where authored `unit.json` sources are read. |
| `ORG_ENTRYPOINT` | `dist/control-plane.js` of the installed `pi-agentic-control-plane` | Path of the `pi-control` daemon script in `pi-control.service`. Resolved with node module resolution from `org-render`'s own package (no hard-coded `/opt` path); set it only to override. Render fails if the resolved file is not built. |
| `ORG_NODE_BIN` | `/usr/bin/node` (unit generator) | Node binary in the rendered `ExecStart`s. |
| `ORG_PI_CLI` | none | Pi's `cli.js`. Required for any unit without `tool:bash` (those units have no shell, so no launcher script). |
| `ORG_PI_BIN` | `/usr/local/bin/pi` (unit generator) | The `pi` launcher; accepted only for units holding `tool:bash`. |
| `ORG_BWRAP_BIN` | none | `bwrap` path exported to bash units and the control plane. |
| `ORG_SWEEP_INTERVAL_MS` | none (daemon default 60000) | Written into `pi-control.service` when set. |
| `ORG_ETC_DIR` | `/etc` | Base for `sysusers.d/`, `tmpfiles.d/` and the polkit rule. |
| `ORG_WORKER_MODE` | `pi` | `pi` or `durable` (anything else is an error). `durable` renders `pi-durable@<id>.service` units instead of `pi-unit@<id>.service` and exports `ORG_WORKER_MODE=durable` to `pi-control.service`, so the daemon starts the units that were rendered. |
| `ORG_DURABLE_BIN` | `dist/worker.js` of the installed `pi-agentic-durable` | Path of the `agentic-pi-durable-worker` script; only used with `ORG_WORKER_MODE=durable`. Render fails if the default is not built/installed. |

The rendered `pi-control.service` also sets `ORG_CONTROL_DB`, `ORG_CONTROL_SOCKET`, `ORG_UNIT_SOCKET_DIR`,
`ORG_WORKSPACE_ROOT`, `ORG_UNITS_DIR`, `ORG_SPAWNER=systemd` (and `ORG_BWRAP_BIN`, `ORG_MANIFEST_DIR`,
`ORG_SWEEP_INTERVAL_MS` when configured). It does not set `ORG_ADMIN_TOKEN_FILE`; add it yourself to enable the
operator inbox.

## Dev and smoke scripts

| Variable | Where | Meaning |
|---|---|---|
| `ORG_UNIT_MANIFEST`, `ORG_CONTROL_DB`, `ORG_CONTROL_SOCKET`, `ORG_UNIT_ID`, `ORG_TASK_ID`, `ORG_UNIT_TOKEN` | `scripts/smoke-pi-ext.ts` | Wires the scripted worker the same way a dispatcher would; the script sets them itself. |
| `ORG_CONTROL_SOCKET`, `ORG_STATE_DIR`, `ORG_WORKSPACE_ROOT`, `ORG_UNIT_SOCKET_DIR`, `ORG_UNITS_DIR`, `ORG_MANIFEST_DIR`, `ORG_SWEEP_INTERVAL_MS`, `ORG_ENTRYPOINT`, `ORG_NODE_BIN`, `ORG_PI_CLI`, `ORG_BWRAP_BIN` | `scripts/smoke.sh` | Exported to `org-render` by the smoke script from its own `REPO`, `STATE_DIR`, ... settings. |
| `ORG_UNIT_ID`, `ORG_TASK_ID`, `ORG_CONTROL_SOCKET`, `ORG_UNIT_MANIFEST` | `scripts/smoke-unit-probe.mjs` | Inspected by the probe that stands in for a worker; it also asserts `ORG_CONTROL_DB`, `ORG_UNIT_TOKEN` and `ORG_ADMIN_TOKEN_FILE` are absent. |

## Worker environment allowlist

The dispatcher builds a production worker's environment from scratch (never from `process.env`): `PATH`, `HOME`
(the unit's agent dir) plus exactly `ORG_UNIT_ID`, `ORG_TASK_ID`, `ORG_CONTROL_SOCKET`, `ORG_UNIT_MANIFEST`,
`ORG_BWRAP`, `ORG_BWRAP_BIN`, `ORG_DURABLE_DIR`, `PI_CODING_AGENT_DIR`, plus the manifest-declared `secrets`
variables. Only the explicit `dev` spawner also forwards `ORG_CONTROL_DB`, `ORG_UNIT_TOKEN` and `AGENTIC_PI_DEV`.
Inside a bubblewrap sandbox the environment is cleared again and only `PATH`, `HOME`, `TMPDIR`, `ORG_UNIT_ID` and
`ORG_TASK_ID` are exported.
