import { test } from "node:test";
import assert from "node:assert/strict";
import { renderWorkerUnit, renderControlUnit, unitUser, unitServiceName } from "../src/systemd.ts";
import { buildBwrapCommand, bindMountsForGrants, mountRootOf } from "../src/bwrap.ts";
import { parseGrants } from "pi-agentic-core";

const PI_CLI = "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

test("unit user and service names are derived safely", () => {
	assert.equal(unitUser("sales"), "pi-u-sales");
	assert.equal(unitServiceName("sales"), "pi-unit@sales.service");
	assert.throws(() => unitUser("../etc"), /unsafe unit id/);
	assert.throws(() => unitServiceName("a b"), /unsafe unit id/);
});

test("worker unit runs as its own user with a scoped write path and no bash syscalls", () => {
	const u = renderWorkerUnit(worker);
	assert.match(u, /User=pi-u-sales/);
	assert.match(u, /WorkingDirectory=\/srv\/org\/sales/);
	assert.match(u, /ReadWritePaths=\/srv\/org\/sales /);
	assert.match(u, /NoNewPrivileges=yes/);
	assert.match(u, /ProtectSystem=strict/);
	assert.match(u, /RestrictAddressFamilies=AF_UNIX/);
	assert.match(u, /Environment=ORG_UNIT_ID=sales/);
	assert.match(u, /^EnvironmentFile=\/run\/pi-control\/env\/sales\.env$/m);
	// Node needs clone (libuv) and W+X (V8 JIT): neither @process nor MDWE.
	assert.match(u, /SystemCallFilter=~@privileged @resources\n/);
	assert.doesNotMatch(u, /@process/);
	assert.doesNotMatch(u, /MemoryDenyWriteExecute=yes/);
	// No bash grant → no shell is reachable.
	assert.match(u, /InaccessiblePaths=-\/bin\/sh -\/bin\/bash/);
	assert.doesNotMatch(u, /ORG_UNIT_TOKEN/);
});

test("bash worker exports ORG_BWRAP=1, keeps process syscalls, has no token or db path", () => {
	const u = renderWorkerUnit({ ...worker, unitId: "eng", workspace: "/srv/org/eng", socketPath: "/run/pi-control/eng.sock", manifestPath: "/etc/agentic-pi/units/eng/unit.json", stateDir: "/var/lib/org-units/eng", taskEnvFile: "/run/pi-control/env/eng.env", allowBash: true });
	assert.match(u, /SystemCallFilter=~@privileged @resources\n/);
	assert.doesNotMatch(u, /@process/);
	assert.doesNotMatch(u, /InaccessiblePaths=-\/bin\/sh/);
	assert.match(u, /^Environment=ORG_BWRAP=1$/m);
	assert.doesNotMatch(u, /ORG_UNIT_TOKEN|ORG_CONTROL_DB/);
});

test("worker unit isolates units: own 0700 state dir writable, control dir + peers inaccessible (agentic-pi-5sp.21)", () => {
	const u = renderWorkerUnit({
		...worker,
		otherUnits: [
			{ id: "sales", stateDir: "/var/lib/org-units/sales", socketPath: "/run/pi-control/sales.sock" },
			{ id: "eng", stateDir: "/var/lib/org-units/eng", socketPath: "/run/pi-control/eng.sock" },
		],
	});
	assert.match(u, /^ReadWritePaths=\/srv\/org\/sales \/var\/lib\/org-units\/sales$/m);
	assert.match(u, /^InaccessiblePaths=-\/var\/lib\/org -\/var\/lib\/org-units\/eng -\/run\/pi-control\/eng\.sock$/m);
	assert.match(u, /^Environment=HOME=\/var\/lib\/org-units\/sales$/m);
	// Fail closed on layouts that would let a worker reach the control dir or collide with a peer.
	assert.throws(() => renderWorkerUnit({ ...worker, socketPath: "/var/lib/org/sales.sock" }), /inside the control state dir/);
	assert.throws(() => renderWorkerUnit({ ...worker, stateDir: "/var/lib/org/units/sales" }), /inside the control state dir/);
	assert.throws(() => renderWorkerUnit({ ...worker, otherUnits: [{ id: "eng", stateDir: "/var/lib/org-units/sales/x", socketPath: "/run/pi-control/eng.sock" }] }), /overlap/);
	assert.throws(() => renderWorkerUnit({ ...worker, otherUnits: [{ id: "eng", stateDir: "/var/lib/org-units/eng", socketPath: "/run/pi-control/sales.sock" }] }), /share a socket/);
});

test("control unit owns the socket dir: RuntimeDirectory 0711, joins unit groups, no overlap with state dir", () => {
	const u = renderControlUnit(control);
	assert.match(u, /^RuntimeDirectory=pi-control$/m);
	assert.match(u, /^RuntimeDirectoryMode=0711$/m);
	assert.match(u, /^SupplementaryGroups=pi-u-sales$/m);
	assert.match(u, /^Environment=ORG_UNIT_SOCKET_DIR=\/run\/pi-control$/m);
	assert.throws(() => renderControlUnit({ ...control, unitSocketDir: "/var/lib/org/socks" }), /RuntimeDirectory|\/run\//);
	assert.throws(() => renderControlUnit({ ...control, stateDir: "/run/pi-control" }), /overlap/);
});

test("control unit runs as pi-control with a single writable state dir", () => {
	const u = renderControlUnit({
		...control,
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
	const { ControlStore } = await import("pi-agentic-control-plane");
	const { parseManifest } = await import("pi-agentic-core");
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
			unitSocketDir: "/run/pi-control",
			unitsRoot: "/var/lib/org-units",
			workspaceRoot: "/srv/org",
			entrypoint: "/opt/agentic-pi/src/rpc/control-plane.ts",
			piCli: PI_CLI,
			bwrapBin: "/usr/bin/bwrap",
		});
		assert.ok(files["pi-control.service"]);
		assert.ok(files["pi-unit@ceo.service"]);
		assert.ok(files["pi-unit@eng.service"]);
		// Per-task id arrives via EnvironmentFile, never baked into the unit.
		assert.match(files["pi-unit@ceo.service"]!, /^EnvironmentFile=\/run\/pi-control\/env\/ceo\.env$/m);
		assert.doesNotMatch(files["pi-unit@ceo.service"]!, /ORG_TASK_ID|ORG_UNIT_TOKEN|ORG_CONTROL_DB/);
		// ceo has no bash grant → shells hidden, no ORG_BWRAP; eng has bash → visible + ORG_BWRAP=1.
		assert.match(files["pi-unit@ceo.service"]!, /InaccessiblePaths=-\/bin\/sh/);
		assert.doesNotMatch(files["pi-unit@ceo.service"]!, /ORG_BWRAP/);
		assert.doesNotMatch(files["pi-unit@eng.service"]!, /InaccessiblePaths=-\/bin\/sh/);
		assert.match(files["pi-unit@eng.service"]!, /^Environment=ORG_BWRAP=1$/m);
		assert.match(files["pi-unit@eng.service"]!, /^Environment=ORG_BWRAP_BIN=\/usr\/bin\/bwrap$/m);
		// Each worker sees only its own socket/state; the other unit's and the control dir are hidden.
		assert.match(files["pi-unit@ceo.service"]!, /^Environment=ORG_CONTROL_SOCKET=\/run\/pi-control\/ceo\.sock$/m);
		assert.match(files["pi-unit@ceo.service"]!, /^InaccessiblePaths=-\/var\/lib\/org -\/var\/lib\/org-units\/eng -\/run\/pi-control\/eng\.sock$/m);
		assert.match(files["pi-unit@eng.service"]!, /^InaccessiblePaths=-\/var\/lib\/org -\/var\/lib\/org-units\/ceo -\/run\/pi-control\/ceo\.sock$/m);
		assert.match(files["pi-unit@ceo.service"]!, /^Environment=PI_CODING_AGENT_DIR=\/var\/lib\/org-units\/ceo\/agent-dir$/m);
		assert.match(files["pi-unit@ceo.service"]!, /^Environment=ORG_UNIT_MANIFEST=\/etc\/agentic-pi\/units\/ceo\/unit\.json$/m);
		// Users, 0700 state dirs with agent-dir, and the start-only polkit rule.
		assert.match(files["sysusers.d/agentic-pi.conf"]!, /^u pi-u-eng /m);
		assert.match(files["sysusers.d/agentic-pi.conf"]!, /^m pi-control pi-u-eng$/m);
		assert.match(files["tmpfiles.d/agentic-pi.conf"]!, /^d \/var\/lib\/org-units\/eng 0700 pi-u-eng pi-u-eng -$/m);
		assert.match(files["tmpfiles.d/agentic-pi.conf"]!, /^d \/var\/lib\/org-units\/eng\/agent-dir 0700 pi-u-eng pi-u-eng -$/m);
		assert.match(files["pi-control.service"]!, /^SupplementaryGroups=pi-u-ceo pi-u-eng$/m);
		assert.match(files["polkit-1/rules.d/50-agentic-pi.rules"]!, /verb"\) === "start"/);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

const worker = {
	unitId: "sales",
	workspace: "/srv/org/sales",
	socketPath: "/run/pi-control/sales.sock",
	manifestPath: "/etc/agentic-pi/units/sales/unit.json",
	stateDir: "/var/lib/org-units/sales",
	controlStateDir: "/var/lib/org",
	taskEnvFile: "/run/pi-control/env/sales.env",
	allowBash: false,
	piCli: PI_CLI,
};
const control = {
	controlDb: "/var/lib/org/control.db",
	socketPath: "/var/lib/org/control.sock",
	stateDir: "/var/lib/org",
	unitSocketDir: "/run/pi-control",
	unitIds: ["sales"],
	workspaceRoot: "/srv/org",
	unitsRoot: "/var/lib/org-units",
	entrypoint: "/opt/agentic-pi/src/rpc/control-plane.ts",
};

test("mountRootOf refuses over-broad or malformed globs (agentic-pi-ih9)", () => {
	for (const bad of ["/*", "/**", "/", "/etc*", "/etc**", "/a/*/b", "/a/b*/c", "/a/**/b", "/a/../b", "/a//b", "/a/b/./c", "/a/b?"]) {
		assert.throws(() => mountRootOf(bad), /path grant|workspace|normalised|control/, bad);
	}
	assert.equal(mountRootOf("/a/b/**"), "/a/b");
	assert.throws(() => buildBwrapCommand({ grants: [{ kind: "path", mode: "rw", pattern: "/*" }], command: "x", workspace: "/srv/w" }));
});

test("bwrap clears the environment and exports only an allowlist (agentic-pi-cpf)", () => {
	process.env.ORG_UNIT_TOKEN = "s3cret";
	try {
		const argv = buildBwrapCommand({ grants: [], command: "env", workspace: "/srv/w", unitId: "eng", taskId: "t1" });
		assert.ok(argv.includes("--clearenv"));
		const names: string[] = [];
		for (let i = 0; i < argv.length; i++) if (argv[i] === "--setenv") names.push(argv[i + 1]!);
		assert.deepEqual(names.sort(), ["HOME", "ORG_TASK_ID", "ORG_UNIT_ID", "PATH", "TMPDIR"]);
		assert.ok(argv.indexOf("--clearenv") < argv.indexOf("--setenv"));
		assert.ok(!argv.some((a) => a.includes("s3cret") || a === "ORG_UNIT_TOKEN"));
	} finally {
		delete process.env.ORG_UNIT_TOKEN;
	}
});

test("ancestor ro grant cannot flip the rw workspace read-only (agentic-pi-1y2)", () => {
	const argv = buildBwrapCommand({ grants: parseGrants(["path:r:/srv/org/**"]), command: "x", workspace: "/srv/org/sales" });
	const ro = argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === "/srv/org");
	const rw = argv.findIndex((a, i) => a === "--bind" && argv[i + 1] === "/srv/org/sales");
	assert.ok(ro !== -1 && rw !== -1 && ro < rw, "ancestor must be bound before the workspace");
	assert.deepEqual(bindMountsForGrants(parseGrants(["path:r:/srv/org/**"]), "/srv/org/sales"), [
		{ root: "/srv/org", writable: false },
		{ root: "/srv/org/sales", writable: true },
	]);
});

test("worker/control units keep Node-compatible hardening (agentic-pi-ln4, atx)", () => {
	const c = renderControlUnit(control);
	assert.match(c, /SystemCallFilter=@system-service\nSystemCallFilter=~@privileged @resources/);
	for (const d of ["ProtectKernelLogs=yes", "ProtectClock=yes", "RestrictNamespaces=yes", "RestrictRealtime=yes", "ProtectProc=invisible"]) {
		assert.ok(c.includes(d), d);
	}
	assert.doesNotMatch(c, /MemoryDenyWriteExecute=yes|^SystemCallFilter=.*@process/m);
	assert.doesNotMatch(renderWorkerUnit({ ...worker, allowBash: true }), /MemoryDenyWriteExecute=yes/);
});

test("systemd values with newlines or unsafe path characters are refused (agentic-pi-1ks)", () => {
	assert.throws(() => renderWorkerUnit({ ...worker, socketPath: "/run/pi-control/x\ny" }), /unsafe socketPath/);
	assert.throws(() => renderWorkerUnit({ ...worker, workspace: "/srv/a\nExecStartPre=/x" }), /unsafe workspace/);
	assert.throws(() => renderWorkerUnit({ ...worker, workspace: "/srv/a /etc" }), /unsafe workspace/);
	assert.throws(() => renderWorkerUnit({ ...worker, workspace: "/srv/%h" }), /unsafe workspace/);
	assert.throws(() => renderWorkerUnit({ ...worker, workspace: "/srv/../etc" }), /unsafe workspace/);
	assert.throws(() => renderWorkerUnit({ ...worker, allowBash: true, piCli: undefined as never, piBin: "/bin/pi --evil" }), /unsafe piBin/);
	assert.throws(() => renderControlUnit({ ...control, stateDir: "/var/lib/a b" }), /unsafe stateDir/);
	assert.throws(() => renderControlUnit({ ...control, entrypoint: "/x\n[Service]" }), /unsafe entrypoint/);
});

test("control and worker units re-allow setrlimit/prlimit64 and return EPERM (agentic-pi-wnk.12)", () => {
	const filter = /SystemCallFilter=~@privileged @resources\nSystemCallFilter=setrlimit prlimit64\nSystemCallErrorNumber=EPERM\n/;
	assert.match(renderControlUnit(control), filter);
	assert.match(renderWorkerUnit(worker), filter);
	assert.match(renderWorkerUnit({ ...worker, allowBash: true }), filter);
});

test("non-bash worker execs node + cli.js, never a sh launcher (agentic-pi-wnk.13)", () => {
	const u = renderWorkerUnit(worker);
	assert.match(u, new RegExp(`^ExecStart=/usr/bin/node ${PI_CLI.replaceAll("/", "\\/").replaceAll(".", "\\.")} --mode json$`, "m"));
	assert.match(u, /InaccessiblePaths=-\/bin\/sh/);
	assert.match(renderWorkerUnit({ ...worker, nodeBin: "/opt/node/bin/node" }), /^ExecStart=\/opt\/node\/bin\/node \/opt\/pi/m);
	// A launcher cannot exec without a shell: refuse rather than render a dead unit.
	const { piCli: _omit, ...noCli } = worker;
	assert.throws(() => renderWorkerUnit({ ...noCli, piBin: "/home/u/.pi/agent/bin/pi" }), /set piCli/);
	assert.throws(() => renderWorkerUnit(noCli), /set piCli/);
	assert.throws(() => renderWorkerUnit({ ...worker, piCli: "/opt/pi/bin/pi" }), /node script/);
	assert.throws(() => renderWorkerUnit({ ...worker, piBin: "/usr/local/bin/pi" }), /mutually exclusive/);
	// Bash units may still use a launcher.
	assert.match(renderWorkerUnit({ ...noCli, allowBash: true, piBin: "/home/u/.pi/agent/bin/pi" }), /^ExecStart=\/home\/u\/.pi\/agent\/bin\/pi --mode json$/m);
});

const DURABLE_BIN = "/opt/agentic-pi/node_modules/pi-agentic-durable/dist/worker.js";

test("durable worker unit: node + durable bin, same hardening, ORG_DURABLE_DIR under the unit state dir", () => {
	const pi = renderWorkerUnit(worker);
	const u = renderWorkerUnit({ ...worker, mode: "durable", durableBin: DURABLE_BIN, piCli: undefined as never });
	assert.match(u, new RegExp(`^ExecStart=/usr/bin/node ${DURABLE_BIN.replace(/[./]/g, "\\$&")}$`, "m"));
	assert.match(u, /^Environment=ORG_DURABLE_DIR=\/var\/lib\/org-units\/sales\/durable$/m);
	assert.match(u, /^User=pi-u-sales$/m);
	assert.match(u, /^Environment=ORG_CONTROL_SOCKET=/m);
	assert.doesNotMatch(u, /ORG_UNIT_TOKEN|ORG_CONTROL_DB|ORG_DURABLE_DIR=\/var\/lib\/org\//);
	// Everything from NoNewPrivileges onward (hardening, filters, InaccessiblePaths, shell hiding) is identical to pi-unit@.
	const hardening = (t: string): string => t.slice(t.indexOf("# --- OS boundary"));
	assert.equal(hardening(u), hardening(pi));
	assert.match(u, /InaccessiblePaths=-\/bin\/sh/);
	assert.match(renderWorkerUnit({ ...worker, mode: "durable", durableBin: DURABLE_BIN, nodeBin: "/opt/node/bin/node" }), /^ExecStart=\/opt\/node\/bin\/node /m);
	assert.throws(() => renderWorkerUnit({ ...worker, mode: "durable" }), /durableBin/);
	assert.throws(() => renderWorkerUnit({ ...worker, mode: "durable", durableBin: "/opt/x/worker" }), /node script/);
	assert.throws(() => renderWorkerUnit({ ...worker, mode: "durable", durableBin: "/opt/x y/worker.js" }), /unsafe durableBin/);
	assert.equal(unitServiceName("sales", "durable"), "pi-durable@sales.service");
});

test("renderUnitFiles with workerMode=durable emits pi-durable@ units, a 0700 durable dir, and polkit for both", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { ControlStore } = await import("pi-agentic-control-plane");
	const { parseManifest } = await import("pi-agentic-core");
	const { renderUnitFiles } = await import("../src/render.ts");
	const dir = mkdtempSync(join(tmpdir(), "agentic-pi-deploy-"));
	const store = new ControlStore(join(dir, "control.db"), {});
	try {
		const big = { tokens: 1000, costUsd: 1, wallClockSec: 1000 };
		store.addUnit(parseManifest({ id: "ceo", path: "ceo", parent: null, owner: "ceo@co", grants: ["tool:read", "delegate:*"], budget: big }));
		const files = renderUnitFiles(store.listUnits(), {
			controlDb: join(dir, "control.db"),
			socketPath: "/var/lib/org/control.sock",
			stateDir: "/var/lib/org",
			unitSocketDir: "/run/pi-control",
			unitsRoot: "/var/lib/org-units",
			workspaceRoot: "/srv/org",
			entrypoint: "/opt/agentic-pi/src/rpc/control-plane.ts",
			workerMode: "durable",
			durableBin: DURABLE_BIN,
		});
		assert.equal(files["pi-unit@ceo.service"], undefined);
		assert.match(files["pi-durable@ceo.service"]!, /^ExecStart=\/usr\/bin\/node \/opt\/agentic-pi\/node_modules\/pi-agentic-durable\/dist\/worker\.js$/m);
		assert.match(files["pi-durable@ceo.service"]!, /^Environment=ORG_DURABLE_DIR=\/var\/lib\/org-units\/ceo\/durable$/m);
		assert.match(files["tmpfiles.d/agentic-pi.conf"]!, /^d \/var\/lib\/org-units\/ceo\/durable 0700 pi-u-ceo pi-u-ceo -$/m);
		assert.match(files["polkit-1/rules.d/50-agentic-pi.rules"]!, /pi-\(unit\|durable\)@/);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bwrap re-binds <workspace>/.pi and .agents read-only after the rw workspace bind (agentic-pi-5sp.31)", () => {
	const argv = buildBwrapCommand({ grants: parseGrants(["path:rw:/srv/org/eng/**"]), command: "true", workspace: "/srv/org/eng" });
	const wsBind = argv.findIndex((a, i) => a === "--bind" && argv[i + 1] === "/srv/org/eng");
	assert.ok(wsBind >= 0);
	for (const dir of ["/srv/org/eng/.pi", "/srv/org/eng/.agents"]) {
		const i = argv.findIndex((a, j) => a === "--ro-bind-try" && argv[j + 1] === dir && argv[j + 2] === dir);
		assert.ok(i > wsBind, `${dir} must be ro-bound after the workspace bind`);
	}
	// Still before the command.
	assert.ok(argv.lastIndexOf("--ro-bind-try") < argv.indexOf("--chdir"));
});

test("worker manifest lives in a root-owned dir, secrets come from a root-owned EnvironmentFile (agentic-pi-5sp.31/.33)", () => {
	assert.throws(() => renderWorkerUnit({ ...worker, manifestPath: "/srv/org/sales/unit.json" }), /manifestPath .* unit-writable/);
	assert.throws(() => renderWorkerUnit({ ...worker, manifestPath: "/var/lib/org-units/sales/unit.json" }), /manifestPath .* unit-writable/);
	const u = renderWorkerUnit({ ...worker, manifestPath: "/etc/agentic-pi/units/sales/unit.json", secretsFile: "/etc/agentic-pi/units/sales/secrets.env" });
	assert.match(u, /^Environment=ORG_UNIT_MANIFEST=\/etc\/agentic-pi\/units\/sales\/unit\.json$/m);
	assert.match(u, /^EnvironmentFile=-\/etc\/agentic-pi\/units\/sales\/secrets\.env$/m);
});

test("control unit sets UMask=0077 and exports ORG_MANIFEST_DIR (agentic-pi-5sp.34/.31)", () => {
	const u = renderControlUnit({ ...control, manifestDir: "/etc/agentic-pi/units" });
	assert.match(u, /^UMask=0077$/m);
	assert.match(u, /^Environment=ORG_MANIFEST_DIR=\/etc\/agentic-pi\/units$/m);
});

test("render emits root-owned manifests + secrets.env tmpfiles entries (agentic-pi-5sp.31/.33)", async () => {
	const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { ControlStore } = await import("pi-agentic-control-plane");
	const { parseManifest } = await import("pi-agentic-core");
	const { renderUnitFiles, renderManifestFiles, loadSourceManifests } = await import("../src/render.ts");
	const dir = mkdtempSync(join(tmpdir(), "agentic-pi-deploy-"));
	const store = new ControlStore(join(dir, "control.db"), {});
	try {
		const big = { tokens: 1000, costUsd: 1, wallClockSec: 1000 };
		const raw = { id: "eng", path: "eng", parent: null, owner: "eng@co", grants: ["tool:read", "path:rw:/srv/org/eng/**"], budget: big, secrets: ["API_KEY"], trust: ["/srv/org/eng"] };
		store.addUnit(parseManifest(raw));
		mkdirSync(join(dir, "ws", "eng"), { recursive: true });
		writeFileSync(join(dir, "ws", "eng", "unit.json"), JSON.stringify(raw));
		const cfg = {
			controlDb: join(dir, "control.db"),
			socketPath: "/var/lib/org/control.sock",
			stateDir: "/var/lib/org",
			unitSocketDir: "/run/pi-control",
			unitsRoot: "/var/lib/org-units",
			workspaceRoot: join(dir, "ws"),
			entrypoint: "/opt/agentic-pi/src/rpc/control-plane.ts",
			piCli: PI_CLI,
		};
		const units = store.listUnits();
		const files = renderUnitFiles(units, cfg);
		assert.match(files["pi-unit@eng.service"]!, /^Environment=ORG_UNIT_MANIFEST=\/etc\/agentic-pi\/units\/eng\/unit\.json$/m);
		assert.match(files["pi-unit@eng.service"]!, /^EnvironmentFile=-\/etc\/agentic-pi\/units\/eng\/secrets\.env$/m);
		assert.match(files["pi-control.service"]!, /^UMask=0077$/m);
		const t = files["tmpfiles.d/agentic-pi.conf"]!;
		assert.match(t, /^d \/etc\/agentic-pi\/units 0755 root root -$/m);
		assert.match(t, /^d \/etc\/agentic-pi\/units\/eng 0755 root root -$/m);
		assert.match(t, /^f \/etc\/agentic-pi\/units\/eng\/secrets\.env 0640 root pi-u-eng -$/m);

		const manifests = renderManifestFiles(units, loadSourceManifests(units, cfg.workspaceRoot));
		const m = JSON.parse(manifests["/etc/agentic-pi/units/eng/unit.json"]!);
		assert.deepEqual(m.secrets, ["API_KEY"]);
		assert.deepEqual(m.trust, ["/srv/org/eng"]);
		assert.equal(parseManifest(m).id, "eng");
		// Without an authored source file the manifest is derived from the db row.
		const derived = renderManifestFiles(units, new Map());
		assert.equal(parseManifest(JSON.parse(derived["/etc/agentic-pi/units/eng/unit.json"]!)).owner, "eng@co");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tmpfiles makes <workspace>/.pi and .agents root-owned and the workspace sticky (agentic-pi-5sp.31)", async () => {
	const { renderTmpfiles } = await import("../src/systemd.ts");
	const t = renderTmpfiles(["eng"], "/var/lib/org-units", { workspaces: { eng: "/srv/org/eng" } });
	assert.match(t, /^d \/srv\/org\/eng 1770 root pi-u-eng -$/m);
	assert.match(t, /^d \/srv\/org\/eng\/\.pi 0755 root root -$/m);
	assert.match(t, /^d \/srv\/org\/eng\/\.agents 0755 root root -$/m);
	assert.throws(() => renderTmpfiles(["eng"], "/var/lib/org-units", { workspaces: { eng: "/srv/org/e ng" } }), /unsafe workspace/);
});

test("bwrap unshares the network unless the unit holds a host: grant", () => {
	const base = { command: "curl x", workspace: "/srv/org/sales" };
	const none = buildBwrapCommand({ ...base, grants: parseGrants(["tool:bash", "path:r:/d/shared/**"]) });
	assert.ok(none.includes("--unshare-net"));
	assert.ok(!none.includes("--share-net"));
	const withHost = buildBwrapCommand({ ...base, grants: parseGrants(["tool:bash", "host:api.example.com"]) });
	assert.ok(withHost.includes("--share-net"));
	assert.ok(!withHost.includes("--unshare-net"));
	// --share-net must follow --unshare-all so it takes effect.
	assert.ok(withHost.indexOf("--share-net") > withHost.indexOf("--unshare-all"));
});
