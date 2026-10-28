#!/usr/bin/env bash
# agentic-pi S6 smoke test (SPEC S6). Run on a Linux VM with systemd, bwrap,
# node >=24 and the `pi` binary on PATH. Proves the OS boundary ADR-0002 /
# ADR-0003 depend on is real: a per-unit user, a hardened worker service, a live
# control plane with one socket per unit, a production dispatch into the rendered
# worker template, per-unit isolation (agentic-pi-5sp.19/.20/.21), one
# end-to-end delegate→complete, and a bwrap-sandboxed bash that cannot escape
# its path grants.
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
UNIT_SOCKET_DIR="${UNIT_SOCKET_DIR:-/run/pi-control}"
UNITS_DIR="${UNITS_DIR:-/var/lib/org-units}"
MANIFEST_DIR="${MANIFEST_DIR:-/etc/agentic-pi/units}"
NODE="${NODE:-$(command -v node)}"
# Pi's cli.js (units without tool:bash run `node cli.js`, never the sh launcher).
PI_CLI="${PI_CLI:-$REPO/node_modules/@earendil-works/pi-coding-agent/dist/cli.js}"
# Dev helper scripts import the pi-agentic* workspace packages; the
# `development` export condition resolves those specifiers to their .ts sources,
# and --experimental-strip-types runs them without a build step.
NODE_RUN="$NODE --conditions development --experimental-strip-types"
# The control plane itself runs from the BUILT dist (what actually ships), via
# plain node and the default export condition.
CONTROL_ENTRY="${CONTROL_ENTRY:-$REPO/packages/control-plane/dist/control-plane.js}"

[ "$(id -u)" -eq 0 ] || die "must run as root (creates users + systemd units)"
command -v systemctl >/dev/null || die "systemd required"
command -v bwrap >/dev/null || die "bubblewrap (bwrap) required"
command -v runuser >/dev/null || die "runuser required"
command -v systemd-sysusers >/dev/null && command -v systemd-tmpfiles >/dev/null || die "systemd-sysusers/systemd-tmpfiles required"
"$NODE" --version | grep -qE 'v(2[4-9]|[3-9][0-9])' || die "node >=24 required"
# The worker probe runs as pi-u-<id> from $REPO: it must be world-readable (not under /root).
case "$REPO" in /root/*|/home/*) die "REPO=$REPO is not readable by unit users; install under /opt" ;; esac

say "0. node sanity: pure core has no deps, packages build, and tests pass"
( cd "$REPO" && npm install && npm run check ) || die "npm run check failed"

say "1. create control-plane user + state dir"
id pi-control >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin pi-control
mkdir -p "$STATE_DIR" "$WORKSPACE_ROOT"
chown pi-control:pi-control "$STATE_DIR"

say "2. seed a tiny org (ceo -> eng, ops) into control.db (+ authored <workspace>/<id>/unit.json each, with trust lists)"
$NODE_RUN "$REPO/scripts/seed-smoke-org.ts" "$DB" "$WORKSPACE_ROOT" || die "seed failed"

say "2b. end-to-end store round-trip (control plane not running yet, so no writer races)"
$NODE_RUN "$REPO/scripts/smoke-e2e.ts" "$DB" "$SOCKET" || die "e2e delegate/complete failed"

say "3. render systemd units + sysusers/tmpfiles/polkit (per-unit users, 0700 state dirs, per-unit sockets)"
[ -f "$PI_CLI" ] || die "Pi cli.js not found at PI_CLI=$PI_CLI (set PI_CLI to <install>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js)"
ORG_CONTROL_SOCKET="$SOCKET" ORG_STATE_DIR="$STATE_DIR" ORG_WORKSPACE_ROOT="$WORKSPACE_ROOT" \
  ORG_UNIT_SOCKET_DIR="$UNIT_SOCKET_DIR" ORG_UNITS_DIR="$UNITS_DIR" ORG_MANIFEST_DIR="$MANIFEST_DIR" ORG_SWEEP_INTERVAL_MS=1000 \
  ORG_ENTRYPOINT="$CONTROL_ENTRY" ORG_NODE_BIN="$NODE" ORG_PI_CLI="$PI_CLI" ORG_BWRAP_BIN="$(command -v bwrap)" \
  $NODE_RUN "$REPO/packages/deploy/src/render.ts" "$DB" /etc/systemd/system
systemd-sysusers /etc/sysusers.d/agentic-pi.conf
systemd-tmpfiles --create /etc/tmpfiles.d/agentic-pi.conf
chown -R pi-control:pi-control "$STATE_DIR"
systemctl daemon-reload

say "4. per-unit users and 0700 state dirs exist, owned by their own unit user"
for id in ceo eng ops; do
  id "pi-u-$id" >/dev/null 2>&1 || die "user pi-u-$id missing"
  got="$(stat -c '%U:%a' "$UNITS_DIR/$id")"
  [ "$got" = "pi-u-$id:700" ] || die "state dir $UNITS_DIR/$id is $got, expected pi-u-$id:700"
  got="$(stat -c '%U:%a' "$UNITS_DIR/$id/agent-dir")"
  [ "$got" = "pi-u-$id:700" ] || die "agent-dir of $id is $got, expected pi-u-$id:700"
  for d in .pi .agents; do
    got="$(stat -c '%U:%G:%a' "$WORKSPACE_ROOT/$id/$d")"
    [ "$got" = "root:root:755" ] || die "$WORKSPACE_ROOT/$id/$d is $got, expected root:root:755"
    if runuser -u "pi-u-$id" -- sh -c ": > '$WORKSPACE_ROOT/$id/$d/planted.ts'" 2>/dev/null; then die "pi-u-$id created a file under $WORKSPACE_ROOT/$id/$d"; fi
    if runuser -u "pi-u-$id" -- mv "$WORKSPACE_ROOT/$id/$d" "$WORKSPACE_ROOT/$id/$d.bak" 2>/dev/null; then die "pi-u-$id renamed $WORKSPACE_ROOT/$id/$d away"; fi
  done
  svc="/etc/systemd/system/pi-unit@$id.service"
  grep -q "^Environment=PI_CODING_AGENT_DIR=$UNITS_DIR/$id/agent-dir$" "$svc" || die "PI_CODING_AGENT_DIR not rendered for $id"
  grep -q "^InaccessiblePaths=-$STATE_DIR " "$svc" || die "control dir not inaccessible for $id"
  grep -q "^Environment=ORG_UNIT_MANIFEST=$MANIFEST_DIR/$id/unit.json$" "$svc" || die "ORG_UNIT_MANIFEST not rendered under the root-owned manifest dir for $id"
  grep -q "^EnvironmentFile=-$MANIFEST_DIR/$id/secrets.env$" "$svc" || die "secrets EnvironmentFile not rendered for $id"
  got="$(stat -c '%U:%G:%a' "$MANIFEST_DIR/$id/unit.json")"
  [ "$got" = "root:root:644" ] || die "manifest of $id is $got, expected root:root:644"
  got="$(stat -c '%U:%G:%a' "$MANIFEST_DIR/$id/secrets.env")"
  [ "$got" = "root:pi-u-$id:640" ] || die "secrets.env of $id is $got, expected root:pi-u-$id:640"
  if runuser -u "pi-u-$id" -- sh -c ": >> '$MANIFEST_DIR/$id/unit.json'" 2>/dev/null; then die "pi-u-$id can write its own manifest"; fi
  grep -q '"trust"' "$MANIFEST_DIR/$id/unit.json" || die "trust list missing from the root-owned manifest of $id"
done

say "5. start control plane: shared socket 0600; per-unit sockets pi-control:pi-u-<id> 0660 in a 0711 dir"
systemctl start pi-control.service
for _ in $(seq 1 50); do [ -S "$SOCKET" ] && [ -S "$UNIT_SOCKET_DIR/eng.sock" ] && break; sleep 0.1; done
[ -S "$SOCKET" ] || die "control socket never appeared"
perm="$(stat -c '%a' "$SOCKET")"
[ "$perm" = "600" ] || die "control socket perms are $perm, expected 600"
perm="$(stat -c '%a' "$UNIT_SOCKET_DIR")"
[ "$perm" = "711" ] || die "unit socket dir perms are $perm, expected 711"
for id in ceo eng ops; do
  [ -S "$UNIT_SOCKET_DIR/$id.sock" ] || die "unit socket for $id missing"
  got="$(stat -c '%U:%G:%a' "$UNIT_SOCKET_DIR/$id.sock")"
  [ "$got" = "pi-control:pi-u-$id:660" ] || die "unit socket $id is $got, expected pi-control:pi-u-$id:660"
done

say "5b. OS peer isolation: as pi-u-ceo, eng's socket / state dir, control.db and the shared socket are unreachable"
CONNECT='require("net").connect(process.argv[1]).on("connect",()=>process.exit(1)).on("error",()=>process.exit(0))'
runuser -u pi-u-ceo -- "$NODE" -e "$CONNECT" "$UNIT_SOCKET_DIR/eng.sock" || die "pi-u-ceo CONNECTED to eng's unit socket"
runuser -u pi-u-ceo -- "$NODE" -e "$CONNECT" "$SOCKET" || die "pi-u-ceo CONNECTED to the shared control socket"
if runuser -u pi-u-ceo -- ls "$UNITS_DIR/eng" >/dev/null 2>&1; then die "pi-u-ceo listed eng's state dir"; fi
if runuser -u pi-u-ceo -- cat "$DB" >/dev/null 2>&1; then die "pi-u-ceo read control.db"; fi
if runuser -u pi-u-ops -- ls "$UNITS_DIR/ceo" >/dev/null 2>&1; then die "pi-u-ops listed ceo's state dir"; fi

say "5c. production dispatch: control plane -> systemd spawner -> hardened pi-unit@eng as pi-u-eng -> probe -> complete over eng's own socket"
# Swap the Pi ExecStart for the isolation probe via a runtime drop-in; every
# hardening directive, User=, Environment= and EnvironmentFile= stays the RENDERED one.
DROPIN=/run/systemd/system/pi-unit@eng.service.d
cleanup_dropin() { rm -rf "$DROPIN"; systemctl daemon-reload || true; }
trap cleanup_dropin EXIT
mkdir -p "$DROPIN"
cat > "$DROPIN/probe.conf" <<EOF
[Service]
ExecStart=
ExecStart=$NODE $REPO/scripts/smoke-unit-probe.mjs --uid $(id -u pi-u-eng) --other-socket $UNIT_SOCKET_DIR/ceo.sock --other-dir $UNITS_DIR/ceo --control-db $DB --complete
EOF
systemctl daemon-reload
if ! $NODE_RUN "$REPO/scripts/smoke-dispatch.ts" "$DB" 60; then
  journalctl -u pi-unit@eng.service --no-pager -o cat | tail -40 >&2
  die "dispatch through the production spawner failed"
fi
JOURNAL="$(journalctl -u pi-unit@eng.service --no-pager -o cat)"
printf '%s\n' "$JOURNAL" | grep -q "PROBE OK" || die "worker probe did not report PROBE OK"
if printf '%s\n' "$JOURNAL" | grep -q "PROBE FAIL"; then die "worker probe reported a failure"; fi
[ "$(systemctl show -p User --value pi-unit@eng.service)" = "pi-u-eng" ] || die "pi-unit@eng does not run as pi-u-eng"
cleanup_dropin
trap - EXIT

say "6b. real pi host contract: PEP, audit, redaction, metering, budget abort"
( cd "$REPO" && $NODE_RUN scripts/smoke-pi-ext.ts ) || die "pi extension host-contract smoke failed"

say "7. bwrap containment: bash cannot read outside its path grants"
# eng is granted rw on /srv/org/eng only. Reading /etc/shadow must fail.
set +e
$NODE_RUN "$REPO/scripts/smoke-bwrap.ts" "cat /etc/shadow"
esc=$?
set -e
[ "$esc" -ne 0 ] || die "bwrap let bash read /etc/shadow"

say "8. stop control plane"
systemctl stop pi-control.service

say "9. audit anchor: export, then detect a tampered chain"
$NODE_RUN "$REPO/scripts/smoke-anchor.ts" "$DB" || die "anchor tamper-evidence failed"

printf '\nSMOKE PASS: OS boundary, per-unit isolation, control plane, production dispatch, e2e, bwrap containment and audit anchor all held.\n'
