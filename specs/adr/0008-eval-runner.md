# ADR-0008: Eval runner as a separate package that closes the FR8 lifecycle loop

## Status

Accepted.

## Context

FR8 (lifecycle) says a unit whose eval pass rate drops below its `min_eval`
becomes `deprecated`, and its new delegations are denied. The control plane
already *consumed* this signal: `ControlStore.sweepLifecycle` reads
`latestEvalRate(unitId)` and transitions the unit to `deprecated`. But nothing
*produced* eval runs — `recordEval` / `latestEvalRate` existed with no harness
feeding them, so the deprecation branch was unreachable in practice.

The SPEC roadmap (step 3, "Harness first") lists an "eval runner" alongside
`org-policy` and the gates. The gates (`pi-agentic-core`) are exactly the right
grading primitive: an eval case is a prompt plus the same `Contract`
(schema → rules → judge) that `complete_task` already grades real artifacts
against.

## Decision

Add `pi-agentic-evals`, a sixth workspace package depending only on `core`
(gates) and `control-plane` (the recorder), consistent with the ADR-0006 DAG.

1. **The runner is pure and `pi`-free.** `runSuite(suite, solve)` grades a
   `Solver`'s output against each case's `Contract` via `runGates`. The solver
   is injected: a real one spawns a worker; a test one returns canned output.
   The runner never imports `pi` or touches the network, so it is deterministic
   and unit-testable.

2. **A throwing solver is a failed case, never a crashed suite.** One broken
   case must not abort the run or let the rate silently skip it. Cases run
   sequentially for a deterministic result and to avoid hammering a worker pool.

3. **Suites load from fail-closed JSON** (`parseSuite`), the same discipline as
   `unit.json` (ADR-0001 / FR1): unknown fields, duplicate case ids, and
   malformed contracts are rejected with a problem list. Judges are code, not
   data — a parsed case carries `contract.judge: true` (a judge stage is
   expected) but the `JudgeFn` is wired in code after loading.

4. **`runAndRecord` is the only bridge to state.** It runs the suite, then calls
   the narrow `EvalRecorder.recordEval(unitId, suite, passed, total)` slice of
   the store (which appends an `eval.record` audit entry). An empty suite
   (rate `null`) records nothing: a 0/0 run must not look like a fresh pass, and
   the lifecycle sweep already treats "no runs" as "no deprecation signal".

## Consequences

- The FR8 loop is closed and tested end to end: a 1/4 suite run records
  rate 0.25, and `sweepLifecycle` then deprecates a unit with `min_eval` 0.8.
- No change to `core` or the control-plane store — the runner reuses the
  existing gate pipeline and the pre-existing `recordEval` API.
- A remote/async eval runner later is just another `EvalRecorder` (e.g. an RPC
  method) and another `Solver` (spawning a headless worker); neither changes the
  pure runner.
- Not addressed here: scheduling periodic eval runs (an operator or the
  scheduler invokes `runAndRecord` today), windowed pass-rate averaging
  (`latestEvalRate` still takes the latest single run, as documented for FR8),
  and a real worker-spawning solver.
