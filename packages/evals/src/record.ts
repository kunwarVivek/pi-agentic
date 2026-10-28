/**
 * Bridge from a suite run to the control plane. `runSuite` is pure; this records
 * its pass count so FR8 lifecycle (`sweepLifecycle`) can deprecate a unit whose
 * latest rate fell below `min_eval`.
 *
 * The recorder is the narrow slice of the store the runner needs, so tests (and
 * a remote recorder later) can stand in without a real `control.db`. The real
 * one is a `ControlStore`, whose `recordEval(unitId, suite, passed, total)`
 * already appends an `eval.record` audit entry and persists an `EvalRow`.
 */
import type { EvalRow } from "pi-agentic-control-plane";
import { runSuite, type EvalSuite, type Solver, type SuiteResult } from "./runner.ts";

/** The slice of the control store the eval runner writes through. */
export interface EvalRecorder {
	recordEval(unitId: string, suite: string, passed: number, total: number): EvalRow;
}

export interface RunAndRecordResult {
	result: SuiteResult;
	/** The persisted row, or null when the suite had no cases (nothing recorded). */
	recorded: EvalRow | null;
}

/**
 * Run a suite against a unit and record the pass count through the control plane.
 *
 * An empty suite (rate === null) is NOT recorded: a 0/0 run would let
 * `latestEvalRate` compute nothing useful and must not look like a fresh pass.
 * The lifecycle sweep already treats "no eval runs" as "no deprecation signal".
 */
export async function runAndRecord(
	recorder: EvalRecorder,
	unitId: string,
	suite: EvalSuite,
	solve: Solver,
): Promise<RunAndRecordResult> {
	const result = await runSuite(suite, solve);
	if (result.total === 0) return { result, recorded: null };
	const recorded = recorder.recordEval(unitId, result.suite, result.passed, result.total);
	return { result, recorded };
}
