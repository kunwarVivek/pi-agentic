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

test("tool:* does not grant shell tools; exact grant does", async () => {
	const { decide } = await import("../src/policy.ts");
	const { parseGrants, SHELL_TOOLS } = await import("../src/grants.ts");
	assert.deepEqual(SHELL_TOOLS, ["bash", "powershell"]);
	const star = parseGrants(["tool:*"]);
	assert.equal(decide(star, { toolName: "bash", paths: [] }).allow, false);
	assert.equal(decide(star, { toolName: "powershell", paths: [] }).allow, false);
	assert.equal(decide(star, { toolName: "mytool", paths: [] }).allow, true);
	assert.equal(decide(parseGrants(["tool:bash"]), { toolName: "bash", paths: [] }).allow, true);
});

test("MCP tools need an mcp:<server> grant on top of the tool grant", () => {
	const mcp = (name: string, grants: string[]) => decide(parseGrants(grants), { toolName: name, paths: [] });
	// tool grant alone is not enough
	assert.equal(mcp("mcp__crm__lookup", ["tool:*"]).allow, false);
	assert.equal(mcp("mcp__crm__lookup", ["mcp:crm"]).allow, false); // no tool grant
	assert.equal(mcp("mcp__crm__lookup", ["tool:*", "mcp:crm"]).allow, true);
	assert.equal(mcp("mcp__crm__lookup", ["tool:mcp__crm__lookup", "mcp:crm"]).allow, true);
	assert.equal(mcp("mcp__crm__lookup", ["tool:*", "mcp:erp"]).allow, false);
	assert.equal(mcp("mcp__crm__lookup", ["tool:*", "mcp:*"]).allow, true);
	// Pi maps `-` to `_` in the namespaced name
	assert.equal(mcp("mcp__my_crm__lookup", ["tool:*", "mcp:my-crm"]).allow, true);
});

test("unattributable or ambiguous MCP tool names are denied", () => {
	const all = ["tool:*", "mcp:*"];
	for (const name of ["mcp__", "mcp__crm", "mcp____x", "mcp__crm__", "mcp__crm_lookup"]) {
		assert.equal(decide(parseGrants(all), { toolName: name, paths: [] }).allow, false, name);
	}
	// server `a` + tool `b__c`  vs  server `a__b` + tool `c`: both must be granted
	assert.equal(decide(parseGrants(["tool:*", "mcp:a"]), { toolName: "mcp__a__b__c", paths: [] }).allow, false);
	assert.equal(decide(parseGrants(["tool:*", "mcp:a", "mcp:a__b"]), { toolName: "mcp__a__b__c", paths: [] }).allow, true);
});

test("explicit mcpServers on a request each need a grant; '*' needs mcp:*", () => {
	const req = (servers: string[], grants: string[]) =>
		decide(parseGrants(["tool:*", ...grants]), { toolName: "read_mcp_resource", paths: [], mcpServers: servers });
	assert.equal(req(["crm"], []).allow, false);
	assert.equal(req(["crm"], ["mcp:crm"]).allow, true);
	assert.equal(req(["*"], ["mcp:crm"]).allow, false);
	assert.equal(req(["*"], ["mcp:*"]).allow, true);
});
