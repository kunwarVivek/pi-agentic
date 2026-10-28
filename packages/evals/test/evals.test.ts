import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "pi-agentic-control-plane";
import { parseManifest } from "pi-agentic-core";
import type { Budget, Contract, JudgeFn } from "pi-agentic-core";
import { runSuite, type EvalSuite, type Solver } from "../src/runner.ts";
import { parseSuite, EvalSuiteError } from "../src/suite.ts";
import { runAndRecord, type EvalRecorder } from "../src/record.ts";

const SUMMARY: Contract = {
	schema: { type: "object", properties: { summary: { type: "string", minLength: 1 } }, required: ["summary"], additionalProperties: false },
};

const suite = (cases: EvalSuite["cases"], judge?: JudgeFn): EvalSuite =>
	judge ? { name: "s", cases, judge } : { name: "s", cases };

// ---- runSuite (pure) ------------------------------------------------------

test("runSuite: all cases pass → rate 1", async () => {
	const s = suite([
		{ id: "a", prompt: "p", contract: SUMMARY },
		{ id: "b", prompt: "q", contract: SUMMARY },
	]);
	const solve: Solver = async () => ({ summary: "ok" });
	const r = await runSuite(s, solve);
	assert.equal(r.passed, 2);
	assert.equal(r.total, 2);
	assert.equal(r.rate, 1);
	assert.ok(r.cases.every((c) => c.pass));
});

test("runSuite: a gate failure lowers the rate and records reasons", async () => {
	const s = suite([
		{ id: "good", prompt: "p", contract: SUMMARY },
		{ id: "bad", prompt: "q", contract: SUMMARY },
	]);
	const solve: Solver = async (c) => (c.id === "good" ? { summary: "ok" } : { summary: "" });
	const r = await runSuite(s, solve);
	assert.equal(r.passed, 1);
	assert.equal(r.total, 2);
	assert.equal(r.rate, 0.5);
	const bad = r.cases.find((c) => c.id === "bad");
	assert.equal(bad?.pass, false);
	assert.equal(bad?.gate?.pass, false);
	assert.ok(bad!.reasons.length > 0);
});

test("runSuite: a throwing solver is a failed case, not a crash", async () => {
	const s = suite([
		{ id: "ok", prompt: "p", contract: SUMMARY },
		{ id: "boom", prompt: "q", contract: SUMMARY },
	]);
	const solve: Solver = async (c) => {
		if (c.id === "boom") throw new Error("worker died");
		return { summary: "ok" };
	};
	const r = await runSuite(s, solve);
	assert.equal(r.passed, 1);
	const boom = r.cases.find((c) => c.id === "boom");
	assert.equal(boom?.gate, null);
	assert.match(boom!.reasons[0]!, /solver failed: worker died/);
});

test("runSuite: per-case judge overrides the suite judge", async () => {
	const suiteJudge: JudgeFn = async () => ({ pass: false, reason: "suite says no" });
	const caseJudge: JudgeFn = async () => ({ pass: true, reason: "case says yes" });
	const s = suite(
		[
			{ id: "uses-suite", prompt: "p", contract: { ...SUMMARY, judge: true } },
			{ id: "uses-case", prompt: "q", contract: { ...SUMMARY, judge: true }, judge: caseJudge },
		],
		suiteJudge,
	);
	const solve: Solver = async () => ({ summary: "ok" });
	const r = await runSuite(s, solve);
	assert.equal(r.cases.find((c) => c.id === "uses-suite")?.pass, false);
	assert.equal(r.cases.find((c) => c.id === "uses-case")?.pass, true);
});

test("runSuite: empty suite has rate null", async () => {
	const r = await runSuite(suite([]), async () => ({ summary: "ok" }));
	assert.equal(r.total, 0);
	assert.equal(r.rate, null);
});

// ---- parseSuite (fail-closed) ---------------------------------------------

test("parseSuite: accepts a well-formed suite", () => {
	const s = parseSuite({
		name: "greet",
		cases: [{ id: "c1", prompt: "say hi", contract: { schema: { type: "object" }, judge: true } }],
	});
	assert.equal(s.name, "greet");
	assert.equal(s.cases.length, 1);
	assert.equal(s.cases[0]!.contract.judge, true);
});

test("parseSuite: rejects duplicate case ids, bad contract, unknown fields", () => {
	assert.throws(
		() =>
			parseSuite({
				name: "x",
				cases: [
					{ id: "dup", prompt: "a", contract: { schema: {} } },
					{ id: "dup", prompt: "b", contract: { schema: {} } },
				],
			}),
		(e) => e instanceof EvalSuiteError && e.problems.some((m) => /duplicated/.test(m)),
	);
	assert.throws(
		() => parseSuite({ name: "x", cases: [{ id: "c", prompt: "p", contract: { schema: "nope" } }] }),
		(e) => e instanceof EvalSuiteError && e.problems.some((m) => /schema must be an object/.test(m)),
	);
	assert.throws(
		() => parseSuite({ name: "x", cases: [], extra: 1 }),
		(e) => e instanceof EvalSuiteError && e.problems.some((m) => /unknown field 'extra'/.test(m)),
	);
});

test("parseSuite: rejects a non-object and a missing name", () => {
	assert.throws(() => parseSuite(42), EvalSuiteError);
	assert.throws(() => parseSuite({ cases: [] }), (e) => e instanceof EvalSuiteError && e.problems.some((m) => /name is required/.test(m)));
});

// ---- runAndRecord with a fake recorder ------------------------------------

test("runAndRecord: records passed/total through the recorder", async () => {
	const calls: Array<{ unitId: string; suite: string; passed: number; total: number }> = [];
	const recorder: EvalRecorder = {
		recordEval: (unitId, suiteName, passed, total) => {
			calls.push({ unitId, suite: suiteName, passed, total });
			return { id: "eval_1", unitId, suite: suiteName, passed, total, at: "2026-01-01T00:00:00.000Z" };
		},
	};
	const s = suite([
		{ id: "a", prompt: "p", contract: SUMMARY },
		{ id: "b", prompt: "q", contract: SUMMARY },
	]);
	const solve: Solver = async (c) => (c.id === "a" ? { summary: "ok" } : { summary: "" });
	const out = await runAndRecord(recorder, "sales", s, solve);
	assert.equal(out.recorded?.id, "eval_1");
	assert.deepEqual(calls, [{ unitId: "sales", suite: "s", passed: 1, total: 2 }]);
});

test("runAndRecord: an empty suite records nothing", async () => {
	let called = false;
	const recorder: EvalRecorder = {
		recordEval: () => {
			called = true;
			return { id: "x", unitId: "u", suite: "s", passed: 0, total: 0, at: "" };
		},
	};
	const out = await runAndRecord(recorder, "u", suite([]), async () => ({ summary: "ok" }));
	assert.equal(out.recorded, null);
	assert.equal(called, false);
});

// ---- integration: a failing eval deprecates the unit (FR8 loop closed) -----

test("runAndRecord → sweepLifecycle deprecates a unit below min_eval", async () => {
	let t = Date.parse("2026-01-01T00:00:00.000Z");
	let n = 0;
	const dir = mkdtempSync(join(tmpdir(), "agentic-pi-evals-"));
	const store = new ControlStore(join(dir, "control.db"), {
		clock: () => t,
		genId: (p) => `${p}_${String(++n).padStart(4, "0")}`,
		retireIdleMs: 10 ** 12, // don't let idle-retirement fire first
	});
	try {
		const BIG: Budget = { tokens: 1000, costUsd: 1, wallClockSec: 1000 };
		store.addUnit(parseManifest({ id: "sales", path: "sales", parent: null, owner: "vp@co", grants: ["tool:read"], budget: BIG, minEval: 0.8 }));

		const s = suite([
			{ id: "a", prompt: "p", contract: SUMMARY },
			{ id: "b", prompt: "q", contract: SUMMARY },
			{ id: "c", prompt: "r", contract: SUMMARY },
			{ id: "d", prompt: "s", contract: SUMMARY },
		]);
		// Only 1/4 pass → rate 0.25 < min_eval 0.8.
		const solve: Solver = async (c) => (c.id === "a" ? { summary: "ok" } : { summary: "" });
		const out = await runAndRecord(store, "sales", s, solve);
		assert.equal(out.recorded?.passed, 1);
		assert.equal(store.latestEvalRate("sales"), 0.25);

		const transitions = store.sweepLifecycle();
		assert.deepEqual(transitions, [{ unitId: "sales", from: "active", to: "deprecated", reason: "low_eval" }]);
		assert.equal(store.getUnit("sales")?.status, "deprecated");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runSuite: a throwing judge fails that case only (fail closed)", async () => {
	const jc: Contract = { ...SUMMARY, judge: true };
	const s = suite(
		[
			{ id: "j", prompt: "p", contract: jc },
			{ id: "ok", prompt: "q", contract: SUMMARY },
		],
		async () => {
			throw new Error("judge exploded");
		},
	);
	const r = await runSuite(s, async () => ({ summary: "ok" }));
	assert.equal(r.total, 2);
	const j = r.cases.find((c) => c.id === "j");
	assert.equal(j?.pass, false);
	assert.ok(j!.reasons.some((x) => x.includes("judge exploded")));
	assert.equal(r.cases.find((c) => c.id === "ok")?.pass, true);
	assert.equal(r.passed, 1);
});

test("parseSuite: invalid / ReDoS-prone / oversized forbiddenPatterns are rejected at parse", () => {
	const mk = (pat: string) => ({
		name: "s",
		cases: [{ id: "a", prompt: "p", contract: { schema: {}, rules: { forbiddenPatterns: [pat] } } }],
	});
	for (const bad of ["(", "(a+)+$", "(a|aa)*", "(a)\\1", "a".repeat(300), ".*.*.*.*x", "\\w+\\w+\\w+$", ".+.+", "a*a*"]) {
		assert.throws(() => parseSuite(mk(bad)), EvalSuiteError, bad);
	}
	assert.doesNotThrow(() => parseSuite(mk("sk-[A-Za-z0-9]{20,}")));
	assert.doesNotThrow(() => parseSuite(mk("password")));
	assert.doesNotThrow(() => parseSuite(mk("a\\\\1"))); // escaped backslash then '1' is not a backreference
	assert.doesNotThrow(() => parseSuite(mk("\\w+-\\w+")));
});
