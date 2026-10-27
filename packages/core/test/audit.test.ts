import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, chain, verify, buildAnchor, anchorIsIntact, verifyAgainstAnchor, type ChainedEntry, type AuditAnchor } from "../src/audit.ts";

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

test("anchor over empty chain uses genesis head", () => {
	const a = buildAnchor([], "t0");
	assert.equal(a.count, 0);
	assert.equal(a.headSeq, 0);
	assert.equal(a.headHash, "0".repeat(64));
	assert.equal(anchorIsIntact(a), true);
	assert.deepEqual(verifyAgainstAnchor([], a), { ok: true, count: 0 });
});

test("anchor verifies a faithful continuation and detects growth", () => {
	const c = build(3);
	const a = buildAnchor(c, "t-anchor");
	assert.equal(a.count, 3);
	assert.equal(a.headSeq, 3);
	assert.equal(anchorIsIntact(a), true);
	assert.deepEqual(verifyAgainstAnchor(c, a), { ok: true, count: 3 });
	const grown = [...c];
	for (let i = 3; i < 6; i++) grown.push(chain(grown.at(-1)!, { at: `t${i}`, actor: "ceo", action: "delegate", subject: `task-${i}`, data: { i } }));
	assert.deepEqual(verifyAgainstAnchor(grown, a), { ok: true, count: 6 });
});

test("anchor detects truncation below the anchored head", () => {
	const c = build(5);
	const a = buildAnchor(c, "t-anchor");
	const r = verifyAgainstAnchor(c.slice(0, 3), a);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.reason, "truncated");
});

test("anchor detects a rewritten history up to the anchored head", () => {
	const c = build(5);
	const a = buildAnchor(c, "t-anchor");
	const forged: ChainedEntry[] = [];
	for (let i = 0; i < 5; i++) forged.push(chain(forged.at(-1) ?? null, { at: `t${i}`, actor: "mallory", action: "delegate", subject: `task-${i}`, data: { i } }));
	assert.equal(verify(forged).ok, true);
	const r = verifyAgainstAnchor(forged, a);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.reason, "head_mismatch");
});

test("a tampered anchor is rejected", () => {
	const c = build(3);
	const a = buildAnchor(c, "t-anchor");
	const bad: AuditAnchor = { ...a, headHash: "f".repeat(64) };
	assert.equal(anchorIsIntact(bad), false);
	const r = verifyAgainstAnchor(c, bad);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.reason, "anchor_corrupt");
});
