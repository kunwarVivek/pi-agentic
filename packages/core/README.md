# pi-agentic-core

The pure, I/O-free kernel of agentic-pi — an agentic org on Pi 1.4.0. No runtime
dependencies, no sqlite, no network, no `pi`. Everything is deterministic and unit-testable; time is always
injected by the caller.

## What it exports

| Area | Exports |
|---|---|
| Manifest | `parseManifest(input)` validates a `unit.json` object fail-closed (unknown fields, bad grants, bad budget all throw `ManifestError` listing every problem); `Manifest`, `Budget`, `MAX_ID_LEN` |
| Grants | `parseGrant`, `parseGrants`, `formatGrant`, `grantCovered`, `uncovered` (child ⊆ parent), `effectiveGrants(unit, task)`, `pathMatches`, `canonicalizePathGrants`, `SHELL_TOOLS` |
| Policy (PDP) | `decide(grants, { toolName, paths })` → `{ allow: true }` or `{ allow: false, reason }`, default deny; `FILE_TOOLS`, `pathAllowed` |
| Delegation | `checkDelegation(request, orgSnapshot)` implements the delegation rules (descendant or explicit `delegate:` grant, no widening, budget fits, depth, fan-out, cycles) |
| Budget | `add`, `sub`, `fits`, `exhausted`, `remaining`, `isValidBudget` |
| Gates | `runGates(contract, artifact, judge?)`: `schema` → `rules` → `judge`, first failure stops; `validateSchema`, `checkRules`, `Contract` |
| Audit | `chain`, `verify`, `canonicalJson`, and the off-host anchor primitives `buildAnchor`, `verifyAgainstAnchor` |

## Example

```ts
import { decide, parseGrants, parseManifest } from "pi-agentic-core";

const manifest = parseManifest({
  id: "eng", path: "eng", parent: "ceo", owner: "eng@example.com",
  grants: ["tool:read", "path:r:/srv/org/eng/**"],
  budget: { tokens: 100000, costUsd: 10, wallClockSec: 3600 },
});

decide(manifest.grants, { toolName: "read", paths: [{ path: "/srv/org/eng/a.txt", mode: "r" }] }); // { allow: true }
decide(manifest.grants, { toolName: "bash", paths: [] });                                       // denied: tool 'bash' not granted
```

The stateful pieces (the `control.db` store, RPC, scheduler) live in `pi-agentic-control-plane`; the Pi hooks live
in `pi-agentic`.

```sh
npm install pi-agentic-core
```

The manifest and grant grammar is documented in the agentic-pi repository under `docs/USER_GUIDE.md`.
Requires Node >= 24. License: MIT.
