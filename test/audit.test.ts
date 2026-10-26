import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, chain, verify, type ChainedEntry } from "../src/core/audit.ts";

test("canonical json is order independent", () => {
	assert.equal(canonicalJson({ b: 1, a: [true, null, { d: "x", c: 2 }] }), '{"a":[true,null,{"c":2,"d":"x"}],"b":1}');
	assert.throws(() => canonicalJson({ x: Number.NaN }));
});

function build(n: number): ChainedEntry[] {
	const out: ChainedEntry[] = [];
	for (let i = 0; i < n; i++) out.push(chain(out.at(-1) ?? null, { at: `t${i}`, actor: "ceo", action: "delegate", subject: `task-${i}`, data: { i } }));
	return out;
}

test("chain verifies and detects tampering", () => {
	const c = build(5);
	assert.deepEqual(verify(c), { ok: true, count: 5 });
	const tampered = c.map((e) => ({ ...e }));
	tampered[2] = { ...tampered[2]!, actor: "mallory" };
	const r = verify(tampered);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.badSeq, 3);
	const dropped = [c[0]!, c[2]!];
	assert.equal(verify(dropped).ok, false);
});
