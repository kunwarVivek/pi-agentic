import { test } from "node:test";
import assert from "node:assert/strict";
import { runGates, validateSchema, type Contract } from "../src/gates.ts";

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
