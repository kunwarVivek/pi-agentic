/**
 * Eval runner (SPEC step 3 "eval runner"; FR8 / G9).
 *
 * The control plane already *consumes* eval pass rates: `sweepLifecycle`
 * deprecates a unit when its latest rate drops below `min_eval`. Nothing
 * *produced* those rates. This module runs a unit's eval suite and returns a
 * pass count; `runAndRecord` (./record.ts) feeds the result back through the
 * control plane so lifecycle can act on it.
 *
 * A suite is a list of cases. Each case is a prompt plus the gate `Contract`
 * (schema -> rules -> judge, from pi-agentic-core) the produced artifact must
 * pass. A `Solver` turns a prompt into an artifact; it is injected so the pure
 * runner never depends on `pi` or the network (a real solver spawns a worker,
 * a test solver returns canned output).
 */
import { type Contract, type GateResult, type JudgeFn, runGates } from "pi-agentic-core";

/** One eval case: a prompt and the gate the produced artifact must pass. */
export interface EvalCase {
	/** Stable id, unique within the suite. */
	id: string;
	/** The input handed to the solver. */
	prompt: string;
	/** The gate the solver's artifact is graded against. */
	contract: Contract;
	/** Optional judge override for this case (else the suite judge, else none). */
	judge?: JudgeFn;
}

/** A named set of eval cases run against a single unit. */
export interface EvalSuite {
	/** Suite name, recorded alongside the result (store `evals.suite`). */
	name: string;
	cases: EvalCase[];
	/** Default judge applied to any case without its own. */
	judge?: JudgeFn;
}

/** Turns a prompt into an artifact to be graded. Injected (no `pi` dependency). */
export type Solver = (caseItem: EvalCase) => Promise<unknown>;

/** The graded outcome of one case. */
export interface CaseResult {
	id: string;
	pass: boolean;
	/** The gate result, or null when the solver or gate/judge threw. */
	gate: GateResult | null;
	/** Failure reasons (gate reasons, or the solver/gate error message). */
	reasons: string[];
}

/** The aggregate outcome of a suite run. */
export interface SuiteResult {
	suite: string;
	passed: number;
	total: number;
	/** passed / total, or null when the suite has no cases (undefined rate). */
	rate: number | null;
	cases: CaseResult[];
}

/**
 * Run every case through the solver and grade it with the gate chain.
 *
 * A case passes only when the solver returns an artifact AND the gate passes.
 * A solver that throws is a failed case (never aborts the suite) so one broken
 * case cannot inflate or crash the rate. Cases run sequentially to keep the
 * result deterministic and avoid hammering a real worker pool.
 */
export async function runSuite(suite: EvalSuite, solve: Solver): Promise<SuiteResult> {
	const cases: CaseResult[] = [];
	let passed = 0;
	for (const c of suite.cases) {
		const judge = c.judge ?? suite.judge;
		let artifact: unknown;
		try {
			artifact = await solve(c);
		} catch (e) {
			cases.push({ id: c.id, pass: false, gate: null, reasons: [`solver failed: ${(e as Error).message}`] });
			continue;
		}
		let gate: GateResult;
		try {
			gate = await runGates(c.contract, artifact, judge);
		} catch (e) {
			// Fail closed: a throwing gate/judge is a failed case, never a suite abort.
			cases.push({ id: c.id, pass: false, gate: null, reasons: [`gate failed: ${(e as Error).message}`] });
			continue;
		}
		if (gate.pass) {
			passed++;
			cases.push({ id: c.id, pass: true, gate, reasons: [] });
		} else {
			cases.push({ id: c.id, pass: false, gate, reasons: gate.reasons });
		}
	}
	const total = suite.cases.length;
	return { suite: suite.name, passed, total, rate: total === 0 ? null : passed / total, cases };
}
