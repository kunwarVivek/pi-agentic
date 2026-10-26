import { test } from "node:test";
import assert from "node:assert/strict";
import { ManifestError, parseManifest, type Manifest } from "../src/core/manifest.ts";
import { checkDelegation, type OrgSnapshot, type UnitStatus } from "../src/core/delegation.ts";
import { parseGrants } from "../src/core/grants.ts";
import { ZERO } from "../src/core/budget.ts";

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
	assert.equal(code(checkDelegation(req(), org({ taskChainUnits: ["ceo", "x", "y", "sales"] }))), "depth");
	assert.equal(code(checkDelegation(req(), org({ openChildren: 8 }))), "fanout");
	assert.equal(code(checkDelegation(req(), org({ taskChainUnits: ["emea", "sales"] }))), "cycle");
	assert.equal(code(checkDelegation(req(), org({}, { emea: "deprecated" }))), "to_inactive");
	assert.equal(code(checkDelegation(req({ toUnit: "sales" }), org())), "self");
});

test("ceo wildcard covers descendants only; lateral needs explicit grant", () => {
	const ceo = org({ callerGrants: parseGrants(["tool:read", "delegate:*"]), taskChainUnits: ["ceo"] });
	assert.deepEqual(checkDelegation(req({ fromUnit: "ceo", toUnit: "eng" }), ceo), { ok: true });
	const lateral = org({ callerGrants: parseGrants(["delegate:*"]), taskChainUnits: ["emea"] });
	const r = checkDelegation(req({ fromUnit: "emea", toUnit: "eng" }), lateral);
	assert.equal(r.ok ? "ok" : r.code, "lateral_needs_explicit");
});
