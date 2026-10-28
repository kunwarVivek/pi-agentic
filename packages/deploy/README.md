# pi-agentic-deploy

Deployment generators for the OS trust boundary of agentic-pi. The Pi `tool_call` hook is
only a policy enforcement point; the real boundary is one Unix user per unit, systemd hardening and a bubblewrap
sandbox for `bash`. This package renders those artifacts.

## What it exports

| Export | Purpose |
|---|---|
| `renderControlUnit`, `renderWorkerUnit` | Hardened `pi-control.service` and the per-unit `pi-unit@<id>.service` / `pi-durable@<id>.service` template (user `pi-u-<id>`, `NoNewPrivileges`, `ProtectSystem=strict`, `RestrictAddressFamilies=AF_UNIX`, syscall filter, ...) |
| `renderSysusers`, `renderTmpfiles`, `renderPolkitRule` | `sysusers.d` / `tmpfiles.d` fragments and the polkit rule that lets only `pi-control` start worker services |
| `buildBwrapCommand`, `bindMountsForGrants` | `bwrap` argv built from a unit's `path:` grants (workspace read-write, grants bound, everything else absent, `.pi`/`.agents` read-only) |
| `renderUnitFiles`, `renderManifestFiles`, `loadSourceManifests` | Map an org's units to files; copy each authored `unit.json` to the root-owned manifest dir |
| bin `org-render` | `org-render <control.db> <out-dir>`: read the live `control.db` and write the unit files |

Rendering is fail closed: paths with whitespace, `%`, quotes or control characters, overlapping unit dirs and
manifests inside a unit-writable path are refused; units without `tool:bash` need `ORG_PI_CLI` (no shell, no
launcher script).

## `org-render`

```sh
ORG_CONTROL_SOCKET=/var/lib/org/control.sock ORG_UNIT_SOCKET_DIR=/run/pi-control ORG_UNITS_DIR=/var/lib/org-units \
ORG_WORKSPACE_ROOT=/srv/org ORG_PI_CLI=/opt/agentic-pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
ORG_BWRAP_BIN="$(command -v bwrap)" ORG_NODE_BIN="$(command -v node)" \
org-render /var/lib/org/control.db /etc/systemd/system
```

Other variables: `ORG_STATE_DIR`, `ORG_MANIFEST_DIR`, `ORG_ETC_DIR`, `ORG_PI_BIN`, `ORG_SWEEP_INTERVAL_MS`,
`ORG_WORKER_MODE=durable` (also exported to `pi-control.service`) with `ORG_DURABLE_BIN`. `ORG_ENTRYPOINT` and
`ORG_DURABLE_BIN` default to the built `dist/` scripts of the installed `pi-agentic-control-plane` /
`pi-agentic-durable` packages; render fails if they are not built. Register units first with
`org units sync <org-root> --db <control.db>`.
See `docs/DEPLOY.md` and `docs/CONFIGURATION.md` in the agentic-pi repository for the full topology and
variable reference.

```sh
npm install pi-agentic-deploy
```

Requires Node >= 24. License: MIT.
