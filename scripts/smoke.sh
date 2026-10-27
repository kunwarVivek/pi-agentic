#!/usr/bin/env bash
# agentic-pi S6 smoke test (SPEC S6). Run on a Linux VM with systemd, bwrap,
# node >=24 and the `pi` binary on PATH. Proves the OS boundary ADR-0002
# depends on is real: a per-unit user, a hardened worker service, a live
# control plane, one end-to-end delegate→complete, and a bwrap-sandboxed bash
# that cannot escape its path grants.
#
# This script is NOT run by `npm test` (it needs root + systemd + Linux). It is
# the manual S6 gate. It is written to fail closed: any step that does not meet
# its assertion aborts the run.
set -euo pipefail

say() { printf '\n=== %s ===\n' "$1"; }
die() { printf 'SMOKE FAIL: %s\n' "$1" >&2; exit 1; }

REPO="${REPO:-/opt/agentic-pi}"
STATE_DIR="${STATE_DIR:-/var/lib/org}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-/srv/org}"
SOCKET="${SOCKET:-$STATE_DIR/control.sock}"
DB="${DB:-$STATE_DIR/control.db}"
NODE="${NODE:-$(command -v node)}"

[ "$(id -u)" -eq 0 ] || die "must run as root (creates users + systemd units)"
command -v systemctl >/dev/null || die "systemd required"
command -v bwrap >/dev/null || die "bubblewrap (bwrap) required"
"$NODE" --version | grep -qE 'v(2[4-9]|[3-9][0-9])' || die "node >=24 required"

say "0. node sanity: pure core has no deps and tests pass"
( cd "$REPO" && npm run check ) || die "npm run check failed"

say "1. create control-plane user + state dir"
id pi-control >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin pi-control
mkdir -p "$STATE_DIR" "$WORKSPACE_ROOT"
chown pi-control:pi-control "$STATE_DIR"

say "2. seed a tiny org (ceo -> eng) into control.db"
"$NODE" "$REPO/scripts/seed-smoke-org.ts" "$DB" "$WORKSPACE_ROOT" || die "seed failed"

say "3. render + install systemd units"
ORG_CONTROL_SOCKET="$SOCKET" ORG_STATE_DIR="$STATE_DIR" ORG_WORKSPACE_ROOT="$WORKSPACE_ROOT" \
  ORG_ENTRYPOINT="$REPO/src/rpc/control-plane.ts" ORG_NODE_BIN="$NODE" \
  "$NODE" "$REPO/src/deploy/render.ts" "$DB" /etc/systemd/system
systemctl daemon-reload

say "4. create per-unit users referenced by the worker services"
for svc in /etc/systemd/system/pi-unit@*.service; do
  u="$(sed -n 's/^User=//p' "$svc" | head -1)"
  id "$u" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$u"
done

say "5. start control plane and wait for the socket"
systemctl start pi-control.service
for _ in $(seq 1 50); do [ -S "$SOCKET" ] && break; sleep 0.1; done
[ -S "$SOCKET" ] || die "control socket never appeared"
# Socket must not be world-writable.
perm="$(stat -c '%a' "$SOCKET")"
[ "$perm" = "600" ] || die "control socket perms are $perm, expected 600"

say "6. end-to-end: delegate ceo->eng, run worker, expect a stored artifact"
"$NODE" "$REPO/scripts/smoke-e2e.ts" "$DB" "$SOCKET" || die "e2e delegate/complete failed"

say "7. bwrap containment: bash cannot read outside its path grants"
# eng is granted rw on /srv/org/eng only. Reading /etc/shadow must fail.
set +e
"$NODE" "$REPO/scripts/smoke-bwrap.ts" "cat /etc/shadow"
esc=$?
set -e
[ "$esc" -ne 0 ] || die "bwrap let bash read /etc/shadow"

say "8. audit anchor: export, then detect a tampered chain"
"$NODE" "$REPO/scripts/smoke-anchor.ts" "$DB" || die "anchor tamper-evidence failed"

say "9. stop control plane"
systemctl stop pi-control.service

printf '\nSMOKE PASS: OS boundary, control plane, e2e, bwrap containment and audit anchor all held.\n'
