/**
 * @agentic-pi/evals — run a unit's eval suite and record the pass rate.
 *
 * `runSuite` grades solver output against gate contracts (pure, no `pi`);
 * `parseSuite` loads a suite from fail-closed JSON; `runAndRecord` feeds the
 * result through the control plane so FR8 lifecycle can deprecate a unit whose
 * latest pass rate fell below its `min_eval`.
 */
export * from "./runner.ts";
export * from "./suite.ts";
export * from "./record.ts";
