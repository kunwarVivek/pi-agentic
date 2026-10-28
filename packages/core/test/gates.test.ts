import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRules, runGates, validateSchema, type Contract } from "../src/gates.ts";
import { MAX_REGEX_INPUT_LENGTH, regexProblem } from "../src/regex-safety.ts";

const contract: Contract = {
	schema: {
		type: "object",
		required: ["summary", "score"],
		additionalProperties: false,
		properties: {
			summary: { type: "string", minLength: 1, maxLength: 200 },
			score: { type: "number", minimum: 0, maximum: 1 },
			tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, maxItems: 2 },
		},
	},
	rules: { forbiddenKeys: ["password"], forbiddenPatterns: ["sk-[A-Za-z0-9]{10,}"], maxBytes: 1000 },
};

test("schema subset", () => {
	assert.deepEqual(validateSchema(contract.schema, { summary: "ok", score: 0.5, tags: ["a"] }), []);
	assert.ok(validateSchema(contract.schema, { summary: "", score: 2, extra: 1 }).length >= 3);
	assert.ok(validateSchema({ type: "object", oneOf: [] }, {})[0]?.includes("unsupported"));
	assert.deepEqual(validateSchema({ type: "integer" }, 3), []);
	assert.equal(validateSchema({ type: "integer" }, 3.5).length, 1);
});

test("gate order stops at first failure", async () => {
	assert.deepEqual(await runGates(contract, { summary: "ok", score: 1 }), { pass: true, stages: ["schema", "rules"] });
	const s = await runGates(contract, { summary: "ok" });
	assert.equal(s.pass === false && s.stage, "schema");
	const r = await runGates(contract, { summary: "key sk-abcdefghijklmnop", score: 1 });
	assert.equal(r.pass === false && r.stage, "rules");
});

test("judge stage fails closed", async () => {
	const j: Contract = { ...contract, judge: true };
	const ok = { summary: "ok", score: 1 };
	assert.equal((await runGates(j, ok)).pass, false);
	assert.equal((await runGates(j, ok, async () => { throw new Error("boom"); })).pass, false);
	assert.equal((await runGates(j, ok, async () => ({ pass: true, reason: "" }))).pass, true);
});

test("non-finite numbers never satisfy a numeric schema", async () => {
	assert.equal(validateSchema({ type: "number", minimum: 0, maximum: 1 }, NaN).length, 1);
	assert.equal(validateSchema({ type: "number" }, Infinity).length, 1);
	assert.equal(validateSchema({ type: "number" }, -Infinity).length, 1);
	// NaN would otherwise pass a bare min/max contract (NaN<min and NaN>max are both false).
	const c: Contract = { schema: { type: "object", properties: { score: { type: "number", minimum: 0, maximum: 1 } } } };
	const g = await runGates(c, { score: NaN });
	assert.equal(g.pass === false && g.stage, "schema");
});

test("runGates is fail-closed when canonicalJson throws on a non-finite artifact", async () => {
	// A rules stage canonicalises the whole artifact; a non-finite value deep in it throws.
	const c: Contract = { schema: { type: "object" }, rules: { maxBytes: 1000 } };
	const g = await runGates(c, { nested: { x: Infinity } });
	assert.equal(g.pass, false);
	assert.equal(g.pass === false && g.stage, "rules");
});

test("malformed schema constraints fail closed", () => {
	assert.ok(validateSchema({ type: "object", required: "summary" as unknown as string[] }, {})[0]?.includes("required"));
	assert.ok(validateSchema({ type: "object", required: [1] as unknown as string[] }, {})[0]?.includes("required"));
	assert.ok(validateSchema({ enum: "a" as unknown as unknown[] }, "a")[0]?.includes("enum"));
	assert.ok(validateSchema({ type: "object", properties: [] as unknown as Record<string, unknown> }, {})[0]?.includes("properties"));
	assert.ok(validateSchema({ type: "array", items: 1 as unknown as Record<string, unknown> }, [])[0]?.includes("items"));
});

test("checkRules: unsafe forbiddenPatterns fail closed with a reason, never throw", () => {
	for (const bad of ["(", "(a+)+$", ".*.*.*.*x", "\\w+\\w+\\w+$", ".+.+", "(a)\\1"]) {
		const errs = checkRules({ forbiddenPatterns: [bad] }, { v: "aaaa" });
		assert.equal(errs.length, 1, bad);
		assert.ok(errs[0]!.includes(bad), bad);
	}
});

test("regexProblem: escaped backslash is not a backreference; non-overlapping neighbours are fine", () => {
	assert.equal(regexProblem("a\\\\1"), undefined);
	assert.equal(regexProblem("\\w+-\\w+"), undefined);
	assert.equal(regexProblem("a+b+"), undefined);
	assert.equal(regexProblem("[0-9]+[a-z]+"), undefined);
	assert.ok(regexProblem("a+a+"));
	assert.ok(regexProblem("\\1(a)"));
});

test("checkRules: oversized artifact text fails closed when patterns are present", () => {
	const big = { v: "x".repeat(MAX_REGEX_INPUT_LENGTH) };
	assert.equal(checkRules({ forbiddenPatterns: ["zzz"] }, big).length, 1);
	assert.deepEqual(checkRules({}, big), []);
});
