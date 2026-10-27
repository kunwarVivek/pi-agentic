# agentic-pi

An **agentic org** of Pi agents — a tree of units (CEO → departments → teams)
that delegate scoped work to one another under a default-deny policy, a hashed
audit chain, and hard budget/lifecycle limits. Built from Pi extensions plus
`node:sqlite` only (ADR-0001): zero runtime dependencies, Node ≥24, a pure
I/O-free core, every path default-deny, and an injected clock for testable time.

## Packages

agentic-pi is an npm workspace of four independently publishable packages that
follow a strict, acyclic dependency DAG (ADR-0006):

| Package | What it is | Depends on |
|---|---|---|
| [`@agentic-pi/core`](packages/core) | The pure kernel: manifest parsing, grant algebra, the policy PDP, the audit hash chain + off-host anchor, budget math, and the gate pipeline. No sqlite, no network, no `pi`. | — |
| [`@agentic-pi/control-plane`](packages/control-plane) | The stateful host side: the single `control.db` writer (store), the JSON-lines RPC protocol + peer auth, the server, dispatcher and scheduler, the `pi-control` daemon, unit config, and the `ControlClient` library (in-process + unix-socket). | core |
| [`@agentic-pi/extension`](packages/extension) | The loadable Pi extension: default-deny tool policy (PEP), secret redaction, the `org_delegate`/`org_complete`/`org_escalate` tools, identity/grants/budget context injection, grant-grounded project trust, and per-turn budget metering. | core, control-plane |
| [`@agentic-pi/deploy`](packages/deploy) | Deployment generators: hardened systemd units (one Unix user per unit), bubblewrap sandbox argv from path grants, and the `org-render` CLI. | core, control-plane |

New functionality is added as a **new package** (or a new module inside one of
these), never by growing the core — the core stays pure and dependency-free.

## Develop

Sources are `.ts` with explicit `.ts` import extensions. Cross-package imports
use the package name (`@agentic-pi/core`), resolved two ways:

- **Dev / tests / `pi -e`**: Node runs the `.ts` sources directly via
  `--experimental-strip-types`, and the `development` export condition resolves
  `@agentic-pi/*` specifiers to each package's `src/index.ts` — no build step.
- **Published consumers**: `tsc --build` emits `dist/*.js` + `dist/*.d.ts` with
  `.js` specifiers (via `rewriteRelativeImportExtensions`), served by the default
  export condition.

```sh
npm install
npm run check   # tsc --build + test-project typecheck, then all tests
npm run build   # emit dist/ for every package
```

Load the extension in a dev Pi session (inert unless `ORG_UNIT_ID` +
`ORG_CONTROL_DB` are set):

```sh
pi -e packages/extension/src/index.ts
```

## Deploy

See [docs/DEPLOY.md](docs/DEPLOY.md) for the OS-boundary topology (`/srv/org`
workspaces, `/var/lib/org` state, the `pi-control` user, one `pi-u-<id>` user
per unit), rendering and installing the systemd units, the bubblewrap sandbox,
and exporting the audit anchor off-host. `scripts/smoke.sh` is the manual
Linux/systemd/bwrap gate.

## Specs

`specs/SPEC.md` is the requirements + threat model; `specs/PLAN.md` tracks the
delivery slices (S0–S7); `specs/adr/` records the architecture decisions.
