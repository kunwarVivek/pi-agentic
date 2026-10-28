# pi-agentic-evals

The eval runner of agentic-pi. It grades a unit's output against gate contracts and records
the pass rate through the control plane, which closes the lifecycle loop: a unit whose latest pass rate falls
below its manifest `minEval` becomes `deprecated` on the next scheduler sweep.

## What it exports

| Export | Purpose |
|---|---|
| `runSuite(suite, solve)` | Pure. Runs each case's prompt through the injected `solve` function and grades the artifact with the gate chain (schema → rules → judge). A throwing solver is a failed case, never a crashed suite; cases run sequentially |
| `parseSuite(json)` | Fail-closed loader for a suite JSON file (unknown fields and bad contracts throw `EvalSuiteError`); judges are code, not data |
| `runAndRecord(recorder, unitId, suite, solve)` | `runSuite`, then `recorder.recordEval(unitId, suite, passed, total)` (a `ControlStore` is a valid recorder). An empty suite records nothing |

Suite file:

```json
{
  "name": "triage-smoke",
  "cases": [
    {
      "id": "ticket-1",
      "prompt": "Classify: 'I cannot log in'",
      "contract": {
        "schema": { "type": "object", "required": ["label"], "properties": { "label": { "enum": ["auth", "billing", "other"] } } },
        "rules": { "forbiddenKeys": ["password"] }
      }
    }
  ]
}
```

```ts
import { readFileSync } from "node:fs";
import { ControlStore } from "pi-agentic-control-plane";
import { parseSuite, runAndRecord } from "pi-agentic-evals";

const suite = parseSuite(JSON.parse(readFileSync("triage.suite.json", "utf8")));
const store = new ControlStore("/var/lib/org/control.db");
const { result } = await runAndRecord(store, "support", suite, async (c) => askMyAgent(c.prompt));
console.log(`${result.passed}/${result.total}`);
store.close();
```

The solver is yours: it can call a model, a Pi session or a canned function, which is why the package has no `pi`
dependency. The `minEval` field is documented in `docs/USER_GUIDE.md` of the agentic-pi repository.

```sh
npm install pi-agentic-evals
```

Requires Node >= 24. License: MIT.
