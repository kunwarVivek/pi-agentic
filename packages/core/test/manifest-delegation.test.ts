import { test } from "node:test";
import assert from "node:assert/strict";
import { ManifestError, parseManifest, type Manifest } from "../src/manifest.ts";
import { checkDelegation, type OrgSnapshot, type UnitStatus } from "../src/delegation.ts";
import { parseGrants } from "../src/grants.ts";
import { ZERO } from "../src/budget.ts";

const B = { tokens: 1000, costUsd: 10, wallClockSec: 3600 };
const m = (id: string, path: string, parent: string | null, grants: string[], extra: object = {}): Manifest =>
	parseManifest({ id, path, parent, owner: `${id}@co`, grants, budget: B, ...extra });

test("manifest validates and defaults", () => {
	const x = m("sales", "sales", "ceo", ["tool:read"]);
	assert.deepEqual(x.limits, { maxDepth: 4, maxChildren: 8, maxAttempts: 2 });
	assert.throws(() => parseManifest({ id: "Bad", grants: ["zzz"], extra: 1 }), (e: unknown) => {
		assert.ok(e instanceof ManifestError);
		assert.ok(e.problems.length >= 4);
		return true;
	});
});

function org(over: Partial<OrgSnapshot> = {}, status: Record<string, UnitStatus> = {}): OrgSnapshot {
	const list = [
		m("ceo", "ceo", null, ["tool:read", "delegate:*"]),
		m("sales", "sales", "ceo", ["tool:read", "path:r:/d/sales/**", "delegate:sales/*"]),
		m("emea", "sales/emea", "sales", ["tool:read", "path:r:/d/sales/emea/**"]),
		m("eng", "eng", "ceo", ["tool:read", "tool:bash"]),
	];
	return {
		units: new Map(list.map((u) => [u.id, { ...u, status: status[u.id] ?? "active" }])),
		callerGrants: parseGrants(["tool:read", "path:r:/d/sales/**", "delegate:sales/*"]),
		callerUsed: ZERO,
		callerReserved: ZERO,
		taskChainUnits: ["ceo", "sales"],
		openChildren: 0,
		...over,
	};
}
const req = (over: object = {}) => ({ fromUnit: "sales", toUnit: "emea", parentTaskId: "t1", grants: undefined, budget: { tokens: 100, costUsd: 1, wallClockSec: 60 }, ...over });

test("valid downward delegation", () => {
	assert.deepEqual(checkDelegation(req({ grants: parseGrants(["path:r:/d/sales/emea/**"]) }), org()), { ok: true });
});

test("rejections", () => {
	const code = (r: ReturnType<typeof checkDelegation>) => (r.ok ? "ok" : r.code);
	assert.equal(code(checkDelegation(req({ toUnit: "eng" }), org())), "not_authorized");
	assert.equal(code(checkDelegation(req({ grants: parseGrants(["tool:bash"]) }), org())), "widening");
	assert.equal(code(checkDelegation(req({ budget: { ...B, tokens: 5000 } }), org())), "budget");
	assert.equal(code(checkDelegation(req(), org({ callerUsed: { tokens: 950, costUsd: 0, wallClockSec: 0 } }))), "budget");
	assert.equal(code(checkDelegation(req(), org({ taskChainUnits: ["ceo", "x", "y", "z", "sales"] }))), "depth");
	assert.equal(code(checkDelegation(req(), org({ openChildren: 8 }))), "fanout");
	assert.equal(code(checkDelegation(req(), org({ taskChainUnits: ["emea", "sales"] }))), "cycle");
	assert.equal(code(checkDelegation(req(), org({}, { emea: "deprecated" }))), "to_inactive");
	assert.equal(code(checkDelegation(req({ toUnit: "sales" }), org())), "self");
	assert.equal(code(checkDelegation(req({ budget: { tokens: -1, costUsd: 1, wallClockSec: 60 } }), org())), "bad_budget");
	assert.equal(code(checkDelegation(req({ budget: { tokens: Number.NaN, costUsd: 1, wallClockSec: 60 } }), org())), "bad_budget");
});

test("ceo wildcard covers descendants only; lateral needs explicit grant", () => {
	const ceo = org({ callerGrants: parseGrants(["tool:read", "delegate:*"]), taskChainUnits: ["ceo"] });
	assert.deepEqual(checkDelegation(req({ fromUnit: "ceo", toUnit: "eng" }), ceo), { ok: true });
	const lateral = org({ callerGrants: parseGrants(["delegate:*"]), taskChainUnits: ["emea"] });
	const r = checkDelegation(req({ fromUnit: "emea", toUnit: "eng" }), lateral);
	assert.equal(r.ok ? "ok" : r.code, "lateral_needs_explicit");
});

test("descendant needs no delegate grant (FR3); non-descendant does", () => {
	const noGrant = org({ callerGrants: parseGrants(["tool:read"]) });
	assert.deepEqual(checkDelegation(req(), noGrant), { ok: true });
	const r = checkDelegation(req({ toUnit: "eng" }), noGrant);
	assert.equal(r.ok ? "ok" : r.code, "not_authorized");
	const listed = org({ callerGrants: parseGrants(["delegate:eng"]) });
	assert.deepEqual(checkDelegation(req({ toUnit: "eng" }), listed), { ok: true });
});

test("max_depth boundary: depth = delegation hops = chain length; 4 ok, 5 rejected", () => {
	const code = (r: ReturnType<typeof checkDelegation>) => (r.ok ? "ok" : r.code);
	assert.equal(code(checkDelegation(req(), org({ taskChainUnits: ["sales"] }))), "ok"); // depth 1
	assert.equal(code(checkDelegation(req(), org({ taskChainUnits: ["a", "b", "c", "sales"] }))), "ok"); // depth 4
	assert.equal(code(checkDelegation(req(), org({ taskChainUnits: ["a", "b", "c", "d", "sales"] }))), "depth"); // depth 5
});

test("fan-out boundary: 7 open ok (8th), 8 open rejected", () => {
	const code = (r: ReturnType<typeof checkDelegation>) => (r.ok ? "ok" : r.code);
	assert.equal(code(checkDelegation(req(), org({ openChildren: 7 }))), "ok");
	assert.equal(code(checkDelegation(req(), org({ openChildren: 8 }))), "fanout");
});

test("manifest secrets: names validated, deduped, default []", () => {
	assert.deepEqual(m("a", "a", null, []).secrets, []);
	assert.deepEqual(m("a", "a", null, [], { secrets: ["API_KEY", "API_KEY", "_X1"] }).secrets, ["API_KEY", "_X1"]);
	assert.throws(() => m("a", "a", null, [], { secrets: ["lower"] }), ManifestError);
	assert.throws(() => m("a", "a", null, [], { secrets: "API_KEY" }), ManifestError);
});

test("tool:* never delegates shell tools", () => {
	const caller = org({ callerGrants: parseGrants(["tool:*", "delegate:sales/*"]) });
	const r = checkDelegation(req({ grants: parseGrants(["tool:bash"]) }), caller);
	assert.equal(r.ok ? "ok" : r.code, "widening");
	assert.deepEqual(checkDelegation(req({ grants: parseGrants(["tool:read"]) }), caller), { ok: true });
	const withBash = org({ callerGrants: parseGrants(["tool:bash", "delegate:sales/*"]) });
	assert.deepEqual(checkDelegation(req({ grants: parseGrants(["tool:bash"]) }), withBash), { ok: true });
});

test("manifest id max 24 chars", () => {
	const ok = "a".repeat(24);
	assert.equal(parseManifest({ id: ok, path: ok, parent: null, owner: "o", grants: [], budget: B }).id, ok);
	assert.throws(() => parseManifest({ id: `${ok}b`, path: "x", parent: null, owner: "o", grants: [], budget: B }), ManifestError);
	assert.throws(() => parseManifest({ id: "x", path: "x", parent: `${ok}b`, owner: "o", grants: [], budget: B }), ManifestError);
});

test("manifest trust validation", () => {
	const mk = (trust?: unknown) => parseManifest({ id: "x", path: "x", parent: null, owner: "o", grants: [], budget: B, ...(trust === undefined ? {} : { trust }) });
	assert.deepEqual(mk().trust, []);
	assert.deepEqual(mk(["/srv/a", "/srv/a", "/srv/b"]).trust, ["/srv/a", "/srv/b"]);
	for (const bad of ["/", "rel", "/a/../b", "/a/*", "/a/**", "/a/", "/a//b", "/a/./b", 5]) {
		assert.throws(() => mk([bad]), ManifestError, String(bad));
	}
	assert.throws(() => mk("/a"), ManifestError);
});
