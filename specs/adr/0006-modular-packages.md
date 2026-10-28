# ADR-0006: Ship as a minimal core plus layered, independently publishable packages

Status: Accepted · 2026-10-27

## Context
The org functionality grew as one private package (`agentic-pi`) run directly
from `.ts` via `--experimental-strip-types`. It is a loadable Pi extension
(`pi -e src/ext/index.ts`) but is not publishable: `package.json` is private
with no `exports`/`bin`, the Pi API is a local types-only shim, and there is no
build emit. The user wants a minimal core with the rest as modular, publishable
extensions — current and future functionality alike — so new capabilities slot
in as new packages instead of growing a monolith.

## Decision
Convert the repo into an npm **workspaces monorepo** with four packages that
follow the real dependency DAG (no cycles):

| Package | Scope | Depends on |
|---|---|---|
| `pi-agentic-core` | Pure, I/O-free kernel: `audit`, `budget`, `delegation`, `gates`, `grants`, `manifest`, `policy`. Zero runtime deps. | — |
| `pi-agentic-control-plane` | Host/daemon + worker-client runtime: `store/control` (the sole `control.db` writer), `rpc/*` (protocol, auth, server, dispatcher, scheduler, `pi-control` entrypoint), the `ControlClient` interface + `LocalControlClient`/`SocketControlClient`, and `unit-config`. | core |
| `pi-agentic` | The loadable Pi extension: `bootstrap` + the five installers (`org-policy`, `org-delegate`, `org-context`, `org-trust`, `org-budget`), `policy-hook`, `redact`, and the default export. | core, control-plane |
| `pi-agentic-deploy` | Deployment generators: `systemd`, `bwrap`, `render` CLI. | core, control-plane |

Rationale for the boundaries:
- The client library lives in `control-plane`, not `extension`, because
  `LocalControlClient` needs the store and `SocketControlClient` needs the wire
  `protocol` — both are control-plane concerns. The extension only consumes the
  `ControlClient` *interface*, so `extension → control-plane` is one-directional
  (no cycle). `unit-config` moves there too since `dispatcher`, `systemd`, and
  `bootstrap` all read it.

### Build + dev workflow (reconciles ADR-0001 zero-deps with publishability)
- Each package keeps `.ts` sources with explicit `.ts` import extensions.
- Publishing builds with `tsc` using `rewriteRelativeImportExtensions` (TS ≥5.7)
  so emitted `dist/*.js` + `dist/*.d.ts` carry correct `.js` specifiers.
- Cross-package imports use the package name (`pi-agentic-core`), never deep
  relative paths. The `exports` map carries a `development` condition →
  `./src/index.ts` and a default → `./dist/index.js`.
- Tests and `pi -e` dev runs stay build-free: run Node with
  `--conditions development --experimental-strip-types`, which resolves
  cross-package specifiers to `.ts` sources via the `development` export
  condition. Published consumers get `dist`.
- `@earendil-works/pi-coding-agent` is an **optional peer dependency** of
  `pi-agentic`; the local `pi-api.ts` shim remains as the structural
  fallback so the package still type-checks and loads with zero hard deps.

## Consequences
- \+ Minimal core stays pure and dependency-free; new functionality is a new
  package depending on core (± control-plane), never a core edit.
- \+ Each package is independently versioned and publishable with its own
  `exports`/`bin`/`files` and a real build artifact.
- \+ The DAG is acyclic and enforced by package boundaries, not convention.
- \- A workspace adds build/tsconfig-reference machinery and a custom
  `development` export condition that dev commands must pass.
- \- Four `package.json`/`tsconfig` files to keep in sync; mitigated by a shared
  `tsconfig.base.json`.
