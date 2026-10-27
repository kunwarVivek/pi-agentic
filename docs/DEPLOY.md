# Deployment (SPEC S6)

agentic-pi's trust boundary is the **OS user**, not the Pi hook (ADR-0002). The
`org-policy` hook is deny-by-default policy enforcement and intent control; it
cannot constrain what a `bash` command does once it runs. So a unit that holds
the `tool:bash` grant **must** run under an OS sandbox. This guide renders and
installs that sandbox.

> **Hard rule:** never ship a unit with `tool:bash` without the sandbox below.
> On a host without systemd + bubblewrap, do not grant `tool:bash` at all.

## Topology

```text
/srv/org        unit workspaces (git, text only), one dir per unit path
/var/lib/org    control.db + control.sock, owned by pi-control
pi-control      long-running control plane (sole control.db writer)
pi-u-<id>       one dedicated Unix user per unit worker
```

## Render the systemd units

Unit files are generated from a live `control.db` — pure text, no secrets:

```sh
ORG_CONTROL_SOCKET=/var/lib/org/control.sock \
ORG_WORKSPACE_ROOT=/srv/org \
ORG_ENTRYPOINT=/opt/agentic-pi/src/rpc/control-plane.ts \
ORG_NODE_BIN="$(command -v node)" \
node src/deploy/render.ts /var/lib/org/control.db /etc/systemd/system
systemctl daemon-reload
```

This writes:

- `pi-control.service` — the control plane, user `pi-control`, `StateDirectory`
  the only writable path, `RestrictAddressFamilies=AF_UNIX`, all caps dropped.
- `pi-unit@<id>.service` — a **template** per unit (the dispatcher fills
  `ORG_TASK_ID` via the `%i` instance specifier). Each runs as `pi-u-<id>` with:
  - `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
    `PrivateDevices`, `MemoryDenyWriteExecute`, empty `CapabilityBoundingSet`;
  - `ReadWritePaths` = the unit workspace only (everything else read-only);
  - `RestrictAddressFamilies=AF_UNIX` — the control socket is the only channel out;
  - a `SystemCallFilter` that **blocks process creation** (`@process`) for units
    without `tool:bash`, so even a hook bypass cannot shell out. Units with
    `tool:bash` keep `@process` but still deny `@privileged`/`@resources`.

Create the per-unit users the templates reference, then start the plane:

```sh
for svc in /etc/systemd/system/pi-unit@*.service; do
  u=$(sed -n 's/^User=//p' "$svc" | head -1)
  id "$u" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$u"
done
systemctl start pi-control.service
```

## bash sandbox (bubblewrap)

A worker's `bash` must be wrapped with `bwrap`, built from the unit's path
grants by `src/deploy/bwrap.ts`:

- `--unshare-all` (user/pid/ipc/uts/cgroup/net), `--die-with-parent`, `--cap-drop ALL`;
- read-only system roots (`/usr`, `/bin`, `/lib`, `/lib64`, `/etc`);
- the workspace bound read-write and set as cwd;
- each `path:rw:` grant bound writable, each `path:r:` grant bound read-only,
  **and nothing else** — a bash command cannot reach a path the unit was not granted.

`buildBwrapCommand` returns an argv for `spawn()` without a shell, so there is
no shell-injection surface in the wrapper itself.

## Audit anchor (off-host tamper evidence)

The audit chain is tamper-evident, but an attacker with write access to
`control.db` could rebuild the whole chain. Closing that residual threat
requires exporting a small **anchor** off-host periodically:

```sh
# Export (store the JSON somewhere the control host cannot rewrite):
node -e "import('./src/store/control.ts').then(async ({ControlStore})=>{const s=new ControlStore(process.argv[1],{});process.stdout.write(JSON.stringify(s.exportAnchor()));s.close();})" /var/lib/org/control.db > anchor.json
```

Later, `store.verifyAnchor(anchor)` returns `truncated`, `head_mismatch`,
`chain_invalid`, or `anchor_corrupt` if the live chain is not a faithful
continuation of what the anchor captured.

## Smoke test

`scripts/smoke.sh` is the manual S6 gate (root + systemd + bwrap + Linux). It is
**not** part of `npm test`. It creates the users, renders and installs the
units, starts the plane, runs an end-to-end delegate→complete, asserts a
bwrap'd bash **cannot** read `/etc/shadow`, and asserts the anchor detects a
tampered chain. Any failed assertion aborts the run (`set -euo pipefail`).

```sh
sudo REPO=/opt/agentic-pi bash scripts/smoke.sh
```
