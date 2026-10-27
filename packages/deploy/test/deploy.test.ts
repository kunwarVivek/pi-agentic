import { test } from "node:test";
import assert from "node:assert/strict";
import { renderWorkerUnit, renderControlUnit, unitUser, unitServiceName } from "../src/systemd.ts";
import { buildBwrapCommand, bindMountsForGrants, mountRootOf } from "../src/bwrap.ts";
import { parseGrants } from "@agentic-pi/core";

test("unit user and service names are derived safely", () => {
	assert.equal(unitUser("sales"), "pi-u-sales");
	assert.equal(unitServiceName("sales"), "pi-unit@sales.service");
	assert.throws(() => unitUser("../etc"), /unsafe unit id/);
	assert.throws(() => unitServiceName("a b"), /unsafe unit id/);
});

test("worker unit runs as its own user with a scoped write path and no bash syscalls", () => {
	const u = renderWorkerUnit({
		unitId: "sales",
		workspace: "/srv/org/sales",
		socketPath: "/var/lib/org/control.sock",
		controlDb: "/var/lib/org/control.db",
		taskId: "task_0001",
		allowBash: false,
	});
	assert.match(u, /User=pi-u-sales/);
	assert.match(u, /WorkingDirectory=\/srv\/org\/sales/);
	assert.match(u, /ReadWritePaths=\/srv\/org\/sales/);
	assert.match(u, /NoNewPrivileges=yes/);
	assert.match(u, /ProtectSystem=strict/);
	assert.match(u, /RestrictAddressFamilies=AF_UNIX/);
	assert.match(u, /Environment=ORG_UNIT_ID=sales/);
	assert.match(u, /Environment=ORG_TASK_ID=task_0001/);
	// No bash grant → process-creation syscalls are blocked.
	assert.match(u, /SystemCallFilter=~@privileged @resources @process/);
	assert.doesNotMatch(u, /ORG_UNIT_TOKEN/);
});

test("worker unit with bash grant allows process syscalls and carries a dev token", () => {
	const u = renderWorkerUnit({
		unitId: "eng",
		workspace: "/srv/org/eng",
		socketPath: "/var/lib/org/control.sock",
		controlDb: "/var/lib/org/control.db",
		taskId: "task_0002",
		allowBash: true,
		token: "deadbeef",
	});
	assert.match(u, /SystemCallFilter=~@privileged @resources\n/);
	assert.doesNotMatch(u, /@process/);
	assert.match(u, /Environment=ORG_UNIT_TOKEN=deadbeef/);
});

test("control unit runs as pi-control with a single writable state dir", () => {
	const u = renderControlUnit({
		controlDb: "/var/lib/org/control.db",
		socketPath: "/var/lib/org/control.sock",
		stateDir: "/var/lib/org",
		entrypoint: "/opt/agentic-pi/src/rpc/control-plane.ts",
		sweepIntervalMs: 30000,
	});
	assert.match(u, /User=pi-control/);
	assert.match(u, /StateDirectory=org/);
	assert.match(u, /ReadWritePaths=\/var\/lib\/org/);
	assert.match(u, /Restart=on-failure/);
	assert.match(u, /Environment=ORG_SWEEP_INTERVAL_MS=30000/);
	assert.match(u, /ExecStart=\/usr\/bin\/node \/opt\/agentic-pi\/src\/rpc\/control-plane\.ts/);
});

test("mountRootOf strips globs to the concrete directory", () => {
	assert.equal(mountRootOf("/d/sales/**"), "/d/sales");
	assert.equal(mountRootOf("/d/sales/*"), "/d/sales");
	assert.equal(mountRootOf("/d/sales/report.md"), "/d/sales/report.md");
	assert.throws(() => mountRootOf("relative/x"), /not absolute/);
});

test("bind mounts collapse per root and rw wins over r", () => {
	const grants = parseGrants(["path:r:/d/shared/**", "path:rw:/d/sales/**", "path:r:/d/sales/**", "tool:bash"]);
	const mounts = bindMountsForGrants(grants);
	assert.deepEqual(mounts, [
		{ root: "/d/sales", writable: true },
		{ root: "/d/shared", writable: false },
	]);
});

test("bwrap argv unshares namespaces, drops caps, and binds grants by mode", () => {
	const grants = parseGrants(["path:rw:/d/sales/**", "path:r:/d/shared/**"]);
	const argv = buildBwrapCommand({
		grants,
		command: "ls -la",
		workspace: "/srv/org/sales",
	});
	assert.equal(argv[0], "/usr/bin/bwrap");
	assert.ok(argv.includes("--unshare-all"));
	assert.ok(argv.includes("--die-with-parent"));
	const capIdx = argv.indexOf("--cap-drop");
	assert.equal(argv[capIdx + 1], "ALL");
	// Workspace bound rw.
	assertPair(argv, "--bind", "/srv/org/sales", "/srv/org/sales");
	// rw grant bound writable, r grant bound read-only.
	assertPair(argv, "--bind", "/d/sales", "/d/sales");
	assertPair(argv, "--ro-bind", "/d/shared", "/d/shared");
	// Command is the shell invocation at the tail.
	assert.equal(argv.at(-1), "ls -la");
	assert.equal(argv.at(-2), "-c");
	assert.equal(argv.at(-3), "/bin/bash");
	assert.equal(argv.at(-4), "/srv/org/sales");
	assert.equal(argv.at(-5), "--chdir");
});

/** Assert that `flag src dst` appears as three consecutive argv entries. */
function assertPair(argv: string[], flag: string, src: string, dst: string): void {
	for (let i = 0; i < argv.length - 2; i++) {
		if (argv[i] === flag && argv[i + 1] === src && argv[i + 2] === dst) return;
	}
	assert.fail(`expected ${flag} ${src} ${dst} in argv`);
}

test("renderUnitFiles emits control + per-unit worker templates with bash flagged", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { ControlStore } = await import("@agentic-pi/control-plane");
	const { parseManifest } = await import("@agentic-pi/core");
	const { renderUnitFiles } = await import("../src/render.ts");
	const dir = mkdtempSync(join(tmpdir(), "agentic-pi-deploy-"));
	const store = new ControlStore(join(dir, "control.db"), {});
	try {
		const big = { tokens: 1000, costUsd: 1, wallClockSec: 1000 };
		store.addUnit(parseManifest({ id: "ceo", path: "ceo", parent: null, owner: "ceo@co", grants: ["tool:read", "delegate:*"], budget: big }));
		store.addUnit(parseManifest({ id: "eng", path: "eng", parent: "ceo", owner: "eng@co", grants: ["tool:read", "tool:bash"], budget: big }));
		const files = renderUnitFiles(store.listUnits(), {
			controlDb: join(dir, "control.db"),
			socketPath: "/var/lib/org/control.sock",
			stateDir: "/var/lib/org",
			workspaceRoot: "/srv/org",
			entrypoint: "/opt/agentic-pi/src/rpc/control-plane.ts",
		});
		assert.ok(files["pi-control.service"]);
		assert.ok(files["pi-unit@ceo.service"]);
		assert.ok(files["pi-unit@eng.service"]);
		// Worker template uses the %i task specifier, not a concrete id.
		assert.match(files["pi-unit@ceo.service"]!, /ORG_TASK_ID=%i/);
		// ceo has no bash grant → process syscalls blocked; eng has bash → allowed.
		assert.match(files["pi-unit@ceo.service"]!, /@process/);
		assert.doesNotMatch(files["pi-unit@eng.service"]!, /@process/);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
