import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGrants } from "../src/grants.ts";
import { decide } from "../src/policy.ts";

const g = parseGrants(["tool:read", "tool:write", "path:rw:/w/**", "path:r:/docs/**"]);

test("default deny for ungranted tool", () => {
	const d = decide(g, { toolName: "bash", paths: [] });
	assert.equal(d.allow, false);
	assert.deepEqual(decide([], { toolName: "read", paths: [] }).allow, false);
});

test("path scopes and modes", () => {
	assert.equal(decide(g, { toolName: "read", paths: [{ path: "/docs/a.md", mode: "r" }] }).allow, true);
	assert.equal(decide(g, { toolName: "write", paths: [{ path: "/docs/a.md", mode: "rw" }] }).allow, false);
	assert.equal(decide(g, { toolName: "write", paths: [{ path: "/w/x.ts", mode: "rw" }] }).allow, true);
	assert.equal(decide(g, { toolName: "read", paths: [{ path: "/etc/passwd", mode: "r" }] }).allow, false);
});
