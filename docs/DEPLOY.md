# Deployment (SPEC S6)

agentic-pi's trust boundary is the **OS user**, not the Pi hook (ADR-0002). The
`org-policy` hook is deny-by-default policy enforcement and intent control; it
cannot constrain what a `bash` command does once it runs. So a unit that holds
the `tool:bash` grant **must** run under an OS sandbox. This guide renders and
installs that sandbox.

Related: [USER_GUIDE.md](USER_GUIDE.md) (manifest, grants, approvals), [CONFIGURATION.md](CONFIGURATION.md)
(every environment variable), [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md).

> **Hard rule:** never ship a unit with `tool:bash` without the sandbox below.
> On a host without systemd + bubblewrap, do not grant `tool:bash` at all.

## Topology

```text
/srv/org        unit workspaces (git, text only), one dir per unit path (+ authored unit.json source)
/etc/agentic-pi/units/<id>/  ROOT-owned: unit.json (0644, ORG_UNIT_MANIFEST) + secrets.env (0640 root:pi-u-<id>)
/var/lib/org    control.db + shared control.sock, owned by pi-control; workers cannot reach it
/run/pi-control one socket per unit (0711 dir; <id>.sock 0660 pi-control:pi-u-<id>)
/var/lib/org-units/<id>  per-unit state, 0700 pi-u-<id>, agent-dir = PI_CODING_AGENT_DIR
pi-control      long-running control plane (sole control.db writer)
pi-u-<id>       one dedicated Unix user + group per unit worker
```

## Build the packages

agentic-pi ships as an npm workspace of seven packages (see ADR-0006). Build the
publishable `dist/` output once per host:

```sh
cd /opt/agentic-pi
npm install
npm run build   # tsc --build across pi-agentic, pi-agentic-{core,control-plane,deploy,cli,evals,durable}
```

The `pi-control` daemon and the `org-render` CLI are the built `bin` entrypoints
of `pi-agentic-control-plane` and `pi-agentic-deploy` respectively.

## Render the systemd units

Unit files are generated from a live `control.db` — pure text, no secrets — so every unit must already be
registered there: run `org units sync <org-root> --db /var/lib/org/control.db` (daemon stopped) or
`org units sync <org-root>` (daemon running), see
[USER_GUIDE.md](USER_GUIDE.md#registering-units). `ORG_ENTRYPOINT` defaults to
`dist/control-plane.js` of the installed `pi-agentic-control-plane` package (resolved from `org-render`'s own
node_modules, not a fixed `/opt` path); set it only to override. With `ORG_WORKER_MODE=durable`,
`ORG_DURABLE_BIN` likewise defaults to `dist/worker.js` of the installed `pi-agentic-durable`, and
`pi-control.service` exports `ORG_WORKER_MODE=durable` so the daemon starts the same `pi-durable@<id>` units
that were rendered. Render fails if the resolved file is not built.

```sh
ORG_CONTROL_SOCKET=/var/lib/org/control.sock \
ORG_UNIT_SOCKET_DIR=/run/pi-control \
ORG_UNITS_DIR=/var/lib/org-units \
ORG_PI_CLI=/opt/agentic-pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
ORG_BWRAP_BIN="$(command -v bwrap)" \
ORG_WORKSPACE_ROOT=/srv/org \
ORG_NODE_BIN="$(command -v node)" \
node packages/deploy/dist/render.js /var/lib/org/control.db /etc/systemd/system
systemctl daemon-reload
```

Authored `unit.json` files live in the org repo at `<ORG_WORKSPACE_ROOT>/<unit path>/unit.json`
(optional `secrets` env-var names and `trust` dirs). Render validates each with `parseManifest`
and **copies it to the root-owned `<ORG_MANIFEST_DIR>/<id>/unit.json`** (default
`/etc/agentic-pi/units`, mode 0644 root:root); `ORG_UNIT_MANIFEST` points there so a
unit can never edit its own grants, `secrets` or `trust`. Without an authored file the manifest
is derived from the db row (no secrets, no trust). Rendering refuses a worker manifest path
inside the unit's workspace or state dir. `pi-control.service` carries `UMask=0077` (sockets
are never group/world-accessible between `listen` and `chmod`) and exports `ORG_MANIFEST_DIR`.

**Secrets.** Env vars named in a unit's manifest `secrets` get their values from the root-owned
`<ORG_MANIFEST_DIR>/<id>/secrets.env` (`KEY=value` lines, mode 0640 `root:pi-u-<id>`), loaded
via `EnvironmentFile=-` in the rendered worker unit. tmpfiles creates it empty; the operator fills
it; render never sees or writes secret values. Those values (and everything in the unit's
`auth.json`) are redacted from tool results.

This writes (unit files into the output dir; the others under `ORG_ETC_DIR`, default `/etc`):

- `pi-control.service` — the control plane, user `pi-control`, `StateDirectory`
  the only writable path, `RestrictAddressFamilies=AF_UNIX`, all caps dropped.
- `pi-unit@<id>.service` — one unit per org unit (per-task id comes from the
  `EnvironmentFile=` the control plane writes). Each runs as `pi-u-<id>` with:
  - `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
    `PrivateDevices`, empty `CapabilityBoundingSet`;
  - `ReadWritePaths` = the unit workspace and its own `0700` state dir only
    (everything else read-only; see "Per-unit isolation" below);
  - `RestrictAddressFamilies=AF_UNIX` — the control socket is the only channel out;
  - a `SystemCallFilter` denying `@privileged`/`@resources`, then re-allowing
    `setrlimit prlimit64` (Node raises `RLIMIT_NOFILE` at startup) with
    `SystemCallErrorNumber=EPERM` so a missed syscall errors instead of SIGSYS-killing
    the process. `MemoryDenyWriteExecute`
    and `@process` are deliberately **not** used: the worker is Node (V8 JIT needs
    W+X memory, libuv needs `clone`). Units without `tool:bash` instead get
    `InaccessiblePaths` over `/bin/sh`, `bash`, `dash`, so there is no shell to exec.
    For that reason `ExecStart` is `<node> <pi cli.js> --mode json` (set `ORG_PI_CLI`,
    e.g. `<install>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`, and
    optionally `ORG_NODE_BIN`), never the managed-install `pi` launcher, which is a
    `#!/bin/sh` script. Rendering a no-bash unit without `piCli` is refused; a
    `piBin` launcher is only accepted for units holding `tool:bash`.
- The control unit gets the same syscall filter (including the `setrlimit` re-allow) plus `ProtectKernelLogs`,
  `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictNamespaces`.
- Rendering fails closed: paths with whitespace, `%`, quotes or control
  characters, and env values containing newlines, are refused.
- The bwrap sandbox starts from `--clearenv` and exports only `PATH`, `HOME`,
  `TMPDIR` (+ `ORG_UNIT_ID`/`ORG_TASK_ID`); no token or control path enters it.
  Path grants must be `/a/b`, `/a/b/*` or `/a/b/**`; anything wider (`/*`, `/etc*`)
  is refused. Mounts are bound shallow-first so an ancestor read-only grant
  cannot shadow the writable workspace.

Create the per-unit users, their `0700` state dirs (with `agent-dir`), and the
control user's membership in each `pi-u-<id>` group from the rendered fragments,
then start the plane:

```sh
systemd-sysusers /etc/sysusers.d/agentic-pi.conf
systemd-tmpfiles --create /etc/tmpfiles.d/agentic-pi.conf
chown -R pi-control:pi-control /var/lib/org
systemctl daemon-reload
systemctl start pi-control.service
```

Re-run render + `systemd-sysusers` + `systemd-tmpfiles` + `systemctl restart pi-control`
whenever a unit is added: new units need their user/group before the control
plane can serve their socket (it **fails closed** and refuses to start without a
`pi-u-<id>` group for every unit).

## Per-unit isolation and sockets (ADR-0003)

Identity is the **socket**, enforced by the OS — not a token the worker holds:

```text
/run/pi-control/                 0711 pi-control   (RuntimeDirectory of pi-control.service)
  <id>.sock                      0660 pi-control:pi-u-<id>   one per unit
  env/<id>.env                   0600 pi-control (dir 0700)  per-task EnvironmentFile (ORG_TASK_ID)
/var/lib/org/                    control.db + shared admin/dev socket (0600); INACCESSIBLE to workers
/var/lib/org-units/<id>/         0700 pi-u-<id>   per-unit state; agent-dir/ = PI_CODING_AGENT_DIR
```

- `pi-control` listens on `/run/pi-control/<id>.sock` for every unit. A
  connection on a unit socket authenticates as that unit without a token; a
  `hello` claiming another unit id, another unit's token, or the admin token is
  rejected. Only `pi-u-<id>` (group) and `pi-control` (owner) can connect.
  `pi-control` joins every `pi-u-<id>` group (`SupplementaryGroups=`, rendered)
  so it can chgrp the sockets without privileges. The shared socket in the
  state dir keeps token auth for the admin CLI / dev.
- Each worker unit makes the **control state dir, every other unit's state dir
  and every other unit's socket** `InaccessiblePaths=`, and may write only its
  workspace and its own `/var/lib/org-units/<id>`. Rendering refuses layouts where
  a worker's socket/state dir sits inside the control state dir or unit dirs overlap.
- **Dispatch (production)**: the control plane's `systemd` spawner (default,
  `ORG_SPAWNER=systemd`) writes `/run/pi-control/env/<id>.env` (`ORG_TASK_ID`)
  and runs `systemctl start pi-unit@<id>.service`. The rendered polkit rule
  (`/etc/polkit-1/rules.d/50-agentic-pi.rules`) lets `pi-control` **start**
  `pi-unit@*.service` and nothing else. A unit with a live worker keeps further
  tasks pending until it exits (one worker per unit).
- The worker environment is an **allowlist**, built from scratch (never
  `process.env`): `ORG_UNIT_ID`, `ORG_TASK_ID`, `ORG_CONTROL_SOCKET` (its own unit
  socket), `ORG_UNIT_MANIFEST` (`<ORG_MANIFEST_DIR>/<id>/unit.json`, root-owned, default
  `/etc/agentic-pi/units`), `PI_CODING_AGENT_DIR`,
  `HOME`, `PATH`, plus `ORG_BWRAP=1` (+ `ORG_BWRAP_BIN`) for units holding
  `tool:bash`. Workers never get `ORG_CONTROL_DB`, a bearer token, or the admin
  token path.
- `ORG_SPAWNER=uid` (control plane **as root**) spawns directly as
  `pi-u-<id>` (uid/gid from `/etc/passwd`) with the same allowlisted env — a
  fallback without systemd hardening. `ORG_SPAWNER=dev` runs workers as the
  control user with the dev token and requires `AGENTIC_PI_DEV=1`; never use it in
  production.

To enable the operator approval inbox, point `pi-control` at an admin-token file
(add `Environment=ORG_ADMIN_TOKEN_FILE=/var/lib/org/admin.token` to
`pi-control.service`, inside the `StateDirectory`). On start it writes a fresh
mode-600 token there. See the approval inbox section below.

## Approval inbox

Escalated tasks route to a human (SPEC FR5/G8). Resolving an approval drives the
task: approve re-opens it as `pending`; deny (or a root TTL expiry) cancels it
and returns its reserved budget to the parent. Both paths go through the control
plane — nothing else writes `control.db` (ADR-0007).

The operator CLI (`pi-agentic-cli`, bin `org`) is a thin admin-token RPC client
run on the control host:

```sh
export ORG_CONTROL_SOCKET=/var/lib/org/control.sock
export ORG_ADMIN_TOKEN_FILE=/var/lib/org/admin.token   # written by pi-control

org approvals list
org approvals approve <approval-id> [choice]
org approvals deny <approval-id> [choice]
```

The admin token grants whole-inbox access, so keep the file mode-600 and readable
only by the operator. A unit owner can instead resolve just their own approvals
from inside their Pi session with the `/approvals` command (owner-scoped).

Owner notifications (task outcomes, lifecycle notices) are read the same way on the control host:

```sh
org notifications          # unacknowledged notifications for every owner
org notifications ack <notification-id>
```

## bash sandbox (bubblewrap)

A worker's `bash` must be wrapped with `bwrap`, built from the unit's path
grants by `pi-agentic-deploy` (`packages/deploy/src/bwrap.ts`):

- `--unshare-all` (user/pid/ipc/uts/cgroup/net), `--die-with-parent`, `--cap-drop ALL`;
- the network stays unshared (`--unshare-net`) unless the unit holds at least one `host:` grant, in which case
  `--share-net` follows. That is all-or-nothing; per-host filtering is not enforced in-process and needs an
  egress proxy or firewall outside the sandbox;
- read-only system roots (`/usr`, `/bin`, `/lib`, `/lib64`, `/etc`);
- the workspace bound read-write and set as cwd;
- each `path:rw:` grant bound writable, each `path:r:` grant bound read-only,
  **and nothing else** — a bash command cannot reach a path the unit was not granted;
- `<workspace>/.pi` and `<workspace>/.agents` are re-bound **read-only** after the rw
  workspace bind, so sandboxed bash cannot plant project extensions or skills that a
  later session would load (only an existing dir can be re-bound; the extension only
  trusts cwds listed in the manifest `trust` dirs).

  The rebind alone cannot stop non-bash `write`/`edit` tools (or a not-yet-existing `.pi`), so
  tmpfiles also creates `<workspace>/.pi` and `<workspace>/.agents` as **root:root 0755** for
  every unit and makes the workspace `root:pi-u-<id>` mode **1770** (sticky), so the unit user can
  neither create anything inside those dirs nor rename/remove them. Consequence: inside the
  workspace a unit can delete or rename only files it owns; pre-existing files must be
  group-writable (`pi-u-<id>`) if the unit should edit them.

`buildBwrapCommand` returns an argv for `spawn()` without a shell, so there is
no shell-injection surface in the wrapper itself.

## Audit anchor (off-host tamper evidence)

The audit chain is tamper-evident, but an attacker with write access to
`control.db` could rebuild the whole chain. Closing that residual threat
requires exporting a small **anchor** off-host periodically:

```sh
# Export (store the JSON somewhere the control host cannot rewrite):
node -e "import('pi-agentic-control-plane').then(async ({ControlStore})=>{const s=new ControlStore(process.argv[1],{});process.stdout.write(JSON.stringify(s.exportAnchor()));s.close();})" /var/lib/org/control.db > anchor.json
```

Later, `store.verifyAnchor(anchor)` returns `truncated`, `head_mismatch`,
`chain_invalid`, or `anchor_corrupt` if the live chain is not a faithful
continuation of what the anchor captured.

## Smoke test

`scripts/smoke.sh` is the manual S6 gate (root + systemd + bwrap + Linux). It is
**not** part of `npm test`. It creates the users, renders and installs the
units, starts the plane, runs an end-to-end delegate→complete, and asserts:

- per-unit state dirs are `pi-u-<id>:0700` (with `agent-dir`), each worker unit
  sets `PI_CODING_AGENT_DIR` and hides the control dir;
- the shared socket is `0600`, the unit socket dir `0711`, every unit socket
  `pi-control:pi-u-<id> 0660`;
- as `pi-u-ceo`, eng's unit socket, the shared socket, eng's state dir and
  `control.db` are **unreachable**;
- **production dispatch**: the live control plane starts the rendered
  `pi-unit@eng.service` through the systemd spawner (a drop-in swaps Pi's
  `ExecStart` for `scripts/smoke-unit-probe.mjs`; every hardening directive stays
  the rendered one). The probe asserts it runs as `pi-u-eng`, has no
  `ORG_CONTROL_DB`/`ORG_UNIT_TOKEN`, authenticates on its own socket without a
  token, cannot connect to another unit's socket, cannot read another unit's
  state dir or `control.db`, and completes its task over its own socket;
- a bwrap'd bash **cannot** read `/etc/shadow`;
- the anchor detects a tampered chain.

Any failed assertion aborts the run (`set -euo pipefail`). Set `PI_CLI` to Pi's
`cli.js` if it is not at `$REPO/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`.

```sh
sudo REPO=/opt/agentic-pi bash scripts/smoke.sh
```

`npm run smoke:pi` (`scripts/smoke-pi-ext.ts`) is the portable host-contract
gate: it loads the extension into the real `pi` binary against a scripted
OpenAI-compatible fake model, with all state in a temp dir under `./.tmp`, and
asserts default-deny (including `@`/`../` spellings), audited decisions with a
verifying chain, tool-result redaction before the model sees it, non-zero
turn metering, and an over-budget abort with exactly one escalation. Run it on
the end machine after every Pi upgrade; `smoke.sh` runs it too.

## Installing the org extension as a Pi package

`pi-agentic` is a real Pi package (keyword `pi-package`, `pi.extensions`
= `./dist/index.js`). It imports no host packages at runtime (its Pi API types are
local), so it declares no `peerDependencies`; `pi-agentic-core`, `pi-agentic-control-plane` and
`pi-agentic-deploy` are plain `dependencies`. Build first
(`npm run build`; `prepack` also builds), then install it into **each unit's own
agent dir** in personal scope, so org-trust participates in `project_trust`
(project-scoped extensions cannot decide trust):

```sh
PI_CODING_AGENT_DIR=/var/lib/org-units/eng/agent-dir pi install /opt/agentic-pi/packages/extension
PI_CODING_AGENT_DIR=/var/lib/org-units/eng/agent-dir pi list
```

A local-path install loads the package in place (no copy), so its workspace
dependencies resolve through `/opt/agentic-pi/node_modules`. Workers then run
`pi --mode json -p` with that `PI_CODING_AGENT_DIR` and **no `-e`**; the
dev-only `pi -e packages/extension/src/index.ts` path still works. Leave
`defaultProjectTrust` at its default: headless Pi treats `ask` as untrusted, and
org-trust grants trust only to a cwd inside a directory listed in the unit manifest's `trust` array.

`npm run simulate:org` (`scripts/simulate-org.ts`) rehearses the whole flow under
`./.tmp/sim-*`: org repo tree with `unit.json` + `AGENTS.md`, `control.db` seeded
from the manifests, a `ControlServer` on a unix socket, a per-unit agent dir
provisioned with the real `pi install`, ceo->eng delegation, the real
`Dispatcher` spawning headless `pi`, and a scripted fake model (in-scope read,
denied out-of-scope read, `org_complete`). It asserts task done, artifact stored,
audited policy decisions, a verifying chain, that the worker never opened
`control.db`, and that the project was trusted via org-trust. Pass `--keep` to
retain the directory. Needs `pi` on PATH.
