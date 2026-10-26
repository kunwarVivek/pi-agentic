import { test } from "node:test";
import assert from "node:assert/strict";
import { GrantParseError, parseGrant, parseGrants, pathMatches, patternWithin, uncovered, effectiveGrants } from "../src/core/grants.ts";

test("parse grant kinds", () => {
	assert.deepEqual(parseGrant("tool:read"), { kind: "tool", name: "read" });
	assert.deepEqual(parseGrant("path:rw:/a/b/**"), { kind: "path", mode: "rw", pattern: "/a/b/**" });
	assert.deepEqual(parseGrant("delegate:sales/*"), { kind: "delegate", target: "sales/*" });
	assert.deepEqual(parseGrant("host:API.x.com"), { kind: "host", host: "api.x.com" });
});

test("parse rejects bad grants", () => {
	for (const g of ["read", "tool:", "path:x:/a", "path:r:rel", "path:r:/a/../b", "delegate:Sales", "nope:x"]) {
		assert.throws(() => parseGrant(g), GrantParseError, g);
	}
});

test("pathMatches", () => {
	assert.ok(pathMatches("/a/b/**", "/a/b"));
	assert.ok(pathMatches("/a/b/**", "/a/b/c/d"));
	assert.ok(!pathMatches("/a/b/**", "/a/bc"));
	assert.ok(pathMatches("/a/b/*", "/a/b/c"));
	assert.ok(!pathMatches("/a/b/*", "/a/b/c/d"));
	assert.ok(pathMatches("/a/b", "/a/b"));
	assert.ok(!pathMatches("/a/b", "/a/b/c"));
	assert.ok(pathMatches("/**", "/anything"));
});

test("patternWithin", () => {
	assert.ok(patternWithin("/a/b/c/**", "/a/b/**"));
	assert.ok(patternWithin("/a/b/**", "/a/b/**"));
	assert.ok(patternWithin("/a/b/c", "/a/b/*"));
	assert.ok(!patternWithin("/a/b/c/**", "/a/b/*"));
	assert.ok(!patternWithin("/a/**", "/a/b/**"));
	assert.ok(!patternWithin("/a/bc/**", "/a/b/**"));
});

test("authority only narrows", () => {
	const parent = parseGrants(["tool:read", "path:rw:/w/**", "path:r:/docs/**", "delegate:sales/*"]);
	assert.deepEqual(uncovered(parseGrants(["tool:read", "path:r:/w/x/**", "delegate:sales/emea"]), parent), []);
	const bad = uncovered(parseGrants(["tool:bash", "path:rw:/docs/**", "delegate:eng", "delegate:sales"]), parent);
	assert.equal(bad.length, 4);
	assert.deepEqual(uncovered(parseGrants(["tool:anything"]), parseGrants(["tool:*"])), []);
	assert.equal(uncovered(parseGrants(["tool:*"]), parseGrants(["tool:read"])).length, 1);
});

test("effective grants drop task grants the unit does not hold", () => {
	const unit = parseGrants(["tool:read", "path:r:/w/**"]);
	assert.deepEqual(effectiveGrants(unit, undefined), unit);
	assert.deepEqual(effectiveGrants(unit, parseGrants(["tool:read", "tool:bash"])), parseGrants(["tool:read"]));
});
