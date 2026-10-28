/**
 * ADR-0003 / agentic-pi-5sp.19, .20: per-unit sockets (identity = socket, OS
 * perms) over REAL unix sockets under ./.tmp, plus the production spawners
 * (unit OS user, env allowlist). Linux-only behaviour (a different uid really
 * being refused by the kernel; systemctl; setuid) is covered by scripts/smoke.sh.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseManifest, type Budget, type Manifest } from "pi-agentic-core";
import { startControlPlane, type ControlPlane } from "../src/control-plane.ts";
import { Dispatcher, type WorkerSpec } from "../src/dispatcher.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import {
	WORKER_ENV_ALLOWLIST,
	buildWorkerEnv,
	createDevSpawner,
	createSystemdSpawner,
	createUidSpawner,
	lookupGroupGid,
	lookupPasswd,
} from "../src/spawners.ts";

const BIG: Budget = { tokens: 100000, costUsd: 100, wallClockSec: 100000 };
const man = (id: string, parent: string | null, grants: string[]): Manifest =>
	parseManifest({ id, path: id, parent, owner: `${id}@co`, grants, budget: BIG });

function tmp(): { dir: string; cleanup: () => void } {
	const root = join(import.meta.dirname, "../../../.tmp");
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(root, "us-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One request/response over a fresh connection to `path`. */
function rpc(path: string, method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
	return new Promise((resolve, reject) => {
		const sock = connect(path);
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("error", reject);
		sock.on("data", (c: string) => {
			buf += c;
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				sock.destroy();
				resolve(JSON.parse(buf.slice(0, nl)));
			}
		});
		sock.on("connect", () => sock.write(`${JSON.stringify({ id: 1, method, params })}\n`));
	});
}

async function plane(dir: string, spawned: WorkerSpec[] = [], extra: object = {}): Promise<ControlPlane> {
	const p = await startControlPlane({
		dbPath: join(dir, "control.db"),
		socketPath: join(dir, "c.sock"),
		autoStart: false,
		spawner: (s) => void spawned.push(s),
		unitSockets: { dir: join(dir, "u"), gidOf: () => process.getgid!() },
		unitsRoot: "/units",
		workspaceRoot: "/srv/org",
		bwrapBin: "/usr/bin/bwrap",
		...extra,
	});
	p.store.addUnit(man("ceo", null, ["tool:read", "delegate:*"]));
	p.store.addUnit(man("eng", "ceo", ["tool:read", "tool:bash"]));
	p.store.addUnit(man("ops", "ceo", ["tool:read"]));
	await p.syncUnitSockets();
	return p;
}

test("unit socket authenticates as its unit with no token; identity = socket", async () => {
	const { dir, cleanup } = tmp();
	const p = await plane(dir);
	try {
		const eng = await rpc(p.unitSocketOf("eng")!, "hello", { version: PROTOCOL_VERSION });
		assert.equal(eng.ok, true, JSON.stringify(eng));
		assert.equal(eng.result.unitId, "eng");
		const ops = await rpc(p.unitSocketOf("ops")!, "hello", { version: PROTOCOL_VERSION });
		assert.equal(ops.result.unitId, "ops");
		// Same claim as the socket identity is fine.
		const same = await rpc(p.unitSocketOf("eng")!, "hello", { version: PROTOCOL_VERSION, unitId: "eng" });
		assert.equal(same.ok, true);
	} finally {
		await p.stop();
		cleanup();
	}
});

test("hello claiming another identity on a unit socket is rejected (id, other unit's token, admin token)", async () => {
	const { dir, cleanup } = tmp();
	const p = await plane(dir, [], { adminTokenFile: undefined });
	try {
		const opsToken = p.registry.issueToken("ops");
		const admin = p.registry.issueAdminToken();
		const eng = p.unitSocketOf("eng")!;
		for (const params of [{ unitId: "ops" }, { token: opsToken }, { token: admin }]) {
			const res = await rpc(eng, "hello", { version: PROTOCOL_VERSION, ...params });
			assert.equal(res.ok, false, JSON.stringify(params));
			assert.equal(res.error.code, "unauthenticated");
		}
		// A request that is not hello never gets a session either.
		const first = await rpc(eng, "snapshot", {});
		assert.equal(first.ok, false);
	} finally {
		await p.stop();
		cleanup();
	}
});

test("a unit-socket session cannot act as another unit (complete_task of a foreign task is forbidden)", async () => {
	const { dir, cleanup } = tmp();
	const p = await plane(dir);
	try {
		const d = p.store.delegate({ fromUnit: "ceo", toUnit: "ops", goal: "g", contract: { schema: { type: "object" } }, budget: { tokens: 100, costUsd: 1, wallClockSec: 10 } });
		assert.ok(d.ok);
		// eng pins ops's task at hello: forbidden, even though eng is authenticated.
		const res = await rpc(p.unitSocketOf("eng")!, "hello", { version: PROTOCOL_VERSION, taskId: d.taskId });
		assert.equal(res.ok, false);
		assert.equal(res.error.code, "forbidden");
	} finally {
		await p.stop();
		cleanup();
	}
});

test("socket + dir permissions: dir 0711, socket 0660 with the unit's group; shared socket stays 0600", async () => {
	const { dir, cleanup } = tmp();
	const p = await plane(dir);
	try {
		assert.equal(statSync(join(dir, "u")).mode & 0o777, 0o711);
		for (const id of ["ceo", "eng", "ops"]) {
			const st = statSync(p.unitSocketOf(id)!);
			assert.equal(st.mode & 0o777, 0o660, id);
			assert.equal(st.gid, process.getgid!(), id);
		}
		assert.equal(statSync(join(dir, "c.sock")).mode & 0o777, 0o600);
	} finally {
		await p.stop();
		cleanup();
	}
});

test("a unit whose pi-u-<id> group does not exist fails closed for THAT unit only: no socket, others served, plane starts (N13)", async () => {
	const { dir, cleanup } = tmp();
	try {
		const first = await plane(dir);
		await first.stop();
		const p = await startControlPlane({
			dbPath: join(dir, "control.db"),
			socketPath: join(dir, "c.sock"),
			autoStart: false,
			spawner: () => {},
			unitSockets: { dir: join(dir, "u2"), gidOf: (id) => (id === "ops" ? undefined : process.getgid!()) },
		});
		try {
			assert.throws(() => statSync(join(dir, "u2", "ops.sock")), "no socket for the unit without a group");
			assert.ok(statSync(join(dir, "u2", "eng.sock")).isSocket(), "sibling units are still served");
			assert.equal(p.socketFailures.length, 1);
			assert.equal(p.socketFailures[0]?.unitId, "ops");
			assert.match(p.socketFailures[0]!.reason, /no group for unit ops/);
			assert.ok(p.store.auditEntries().some((e) => e.action === "unit.socket_error" && e.subject === "ops"));
		} finally {
			await p.stop();
		}
	} finally {
		cleanup();
	}
});

test("production spawner kinds require per-unit sockets; dev spawner needs AGENTIC_PI_DEV=1", async () => {
	const { dir, cleanup } = tmp();
	try {
		await assert.rejects(startControlPlane({ dbPath: join(dir, "a.db"), socketPath: join(dir, "a.sock"), autoStart: false }), /per-unit sockets/);
		const prev = process.env.AGENTIC_PI_DEV;
		delete process.env.AGENTIC_PI_DEV;
		try {
			assert.throws(() => createDevSpawner(), /AGENTIC_PI_DEV=1/);
		} finally {
			if (prev !== undefined) process.env.AGENTIC_PI_DEV = prev;
		}
	} finally {
		cleanup();
	}
});

test("dispatched spec: unit socket, manifest, agent dir, ORG_BWRAP for bash units, no token/db", async () => {
	const { dir, cleanup } = tmp();
	const spawned: WorkerSpec[] = [];
	const p = await plane(dir, spawned);
	try {
		for (const to of ["eng", "ops"]) {
			const d = p.store.delegate({ fromUnit: "ceo", toUnit: to, goal: "g", contract: { schema: { type: "object" } }, budget: { tokens: 100, costUsd: 1, wallClockSec: 10 } });
			assert.ok(d.ok);
		}
		await p.scheduler.sweep();
		const by = Object.fromEntries(spawned.map((s) => [s.unit.id, s.env]));
		assert.equal(by.eng!.ORG_CONTROL_SOCKET, join(dir, "u", "eng.sock"));
		assert.equal(by.eng!.ORG_UNIT_MANIFEST, "/etc/agentic-pi/units/eng/unit.json", "root-owned manifest dir by default");
		assert.equal(by.eng!.PI_CODING_AGENT_DIR, "/units/eng/agent-dir");
		assert.equal(by.eng!.ORG_BWRAP, "1");
		assert.equal(by.eng!.ORG_BWRAP_BIN, "/usr/bin/bwrap");
		assert.equal(by.ops!.ORG_BWRAP, undefined);
		for (const env of Object.values(by)) {
			assert.equal(env.ORG_UNIT_TOKEN, undefined);
			assert.equal(env.ORG_CONTROL_DB, undefined);
		}
	} finally {
		await p.stop();
		cleanup();
	}
});

test("buildWorkerEnv is an allowlist: control-plane secrets in process.env never reach the worker", () => {
	process.env.ORG_ADMIN_TOKEN_FILE = "/var/lib/org/admin.token";
	process.env.AWS_SECRET_ACCESS_KEY = "shh";
	try {
		const spec = {
			mode: "pi",
			cwd: "/srv/org/eng",
			env: { ORG_UNIT_ID: "eng", ORG_TASK_ID: "t1", ORG_CONTROL_SOCKET: "/s", ORG_UNIT_TOKEN: "tok", ORG_CONTROL_DB: "/db", EVIL: "x", ORG_ADMIN_TOKEN_FILE: "/a" },
		} as unknown as WorkerSpec;
		const env = buildWorkerEnv(spec);
		assert.deepEqual(Object.keys(env).sort(), ["HOME", "ORG_CONTROL_SOCKET", "ORG_TASK_ID", "ORG_UNIT_ID", "PATH"]);
		assert.ok(Object.keys(env).every((k) => k === "PATH" || k === "HOME" || WORKER_ENV_ALLOWLIST.includes(k)));
		const dev = buildWorkerEnv(spec, { dev: true });
		assert.equal(dev.ORG_UNIT_TOKEN, "tok");
		assert.equal(dev.AGENTIC_PI_DEV, "1");
		assert.equal(dev.EVIL, undefined);
		assert.equal(dev.AWS_SECRET_ACCESS_KEY, undefined);
	} finally {
		delete process.env.ORG_ADMIN_TOKEN_FILE;
		delete process.env.AWS_SECRET_ACCESS_KEY;
	}
});

test("uid spawner runs the worker as pi-u-<id> (uid+gid from passwd) with the allowlisted env; refuses non-root / unknown / root user", () => {
	const { dir, cleanup } = tmp();
	try {
		const passwd = join(dir, "passwd");
		writeFileSync(passwd, "root:x:0:0::/root:/bin/sh\npi-u-eng:x:991:992::/nonexistent:/usr/sbin/nologin\npi-u-bad:x:0:0::/x:/bin/sh\n");
		assert.deepEqual(lookupPasswd(readFileSync(passwd, "utf8"), "pi-u-eng"), { uid: 991, gid: 992 });
		assert.equal(lookupGroupGid("pi-u-eng:x:777:pi-control\n", "pi-u-eng"), 777);
		assert.throws(() => createUidSpawner({ isRoot: () => false }), /needs root/);

		const calls: Array<{ cmd: string; opts: Record<string, any> }> = [];
		const spawnFn = ((cmd: string, _a: string[], opts: Record<string, any>) => {
			calls.push({ cmd, opts });
			return { unref() {} };
		}) as never;
		const sp = createUidSpawner({ isRoot: () => true, passwdFile: passwd, spawnFn });
		const mk = (id: string): WorkerSpec =>
			({ mode: "pi", cwd: "/srv/org/x", unit: { id }, env: { ORG_UNIT_ID: id, ORG_TASK_ID: "t", ORG_CONTROL_SOCKET: "/s", SECRET: "no" } }) as unknown as WorkerSpec;
		sp(mk("eng"));
		assert.equal(calls[0]!.opts.uid, 991);
		assert.equal(calls[0]!.opts.gid, 992);
		assert.equal(calls[0]!.opts.env.SECRET, undefined);
		assert.equal(calls[0]!.opts.env.ORG_CONTROL_SOCKET, "/s");
		assert.throws(() => sp(mk("ghost")), /does not exist/);
		assert.throws(() => sp(mk("bad")), /does not exist \(or is root\)/);
		assert.equal(calls.length, 1);
	} finally {
		cleanup();
	}
});

test("systemd spawner writes a 0600 per-task env file and starts pi-unit@<id>; busy units are detected", async () => {
	const { dir, cleanup } = tmp();
	try {
		const ran: string[][] = [];
		let state = "inactive";
		const sd = createSystemdSpawner({
			envDir: join(dir, "env"),
			run: async (cmd, args) => {
				ran.push([cmd, ...args]);
				return { stdout: args[0] === "show" ? `${state}\n` : "" };
			},
		});
		assert.equal(statSync(join(dir, "env")).mode & 0o777, 0o700);
		const spec = { mode: "pi", cwd: "/w", unit: { id: "eng" }, env: { ORG_TASK_ID: "task_1", ORG_CONTROL_SOCKET: "/s" } } as unknown as WorkerSpec;
		await sd.spawn(spec);
		const f = join(dir, "env", "eng.env");
		assert.equal(readFileSync(f, "utf8"), "ORG_TASK_ID=task_1\n");
		assert.equal(statSync(f).mode & 0o777, 0o600);
		assert.deepEqual(ran.at(-1), ["systemctl", "start", "pi-unit@eng.service"]);
		assert.equal(await sd.isBusy("eng"), false);
		state = "active";
		assert.equal(await sd.isBusy("eng"), true);
		// Values that could inject lines into the EnvironmentFile are refused.
		await assert.rejects(async () => sd.spawn({ ...spec, env: { ORG_TASK_ID: "a\nORG_X=1" } } as unknown as WorkerSpec), /unsafe value/);
		// Durable mode starts pi-durable@<id>; ORG_DURABLE_DIR is pinned by the unit, never written to the env file.
		await sd.spawn({ ...spec, mode: "durable", env: { ...spec.env, ORG_DURABLE_DIR: "/var/lib/org/durable/eng" } } as unknown as WorkerSpec);
		assert.deepEqual(ran.at(-1), ["systemctl", "start", "pi-durable@eng.service"]);
		assert.equal(readFileSync(f, "utf8"), "ORG_TASK_ID=task_1\n");
	} finally {
		cleanup();
	}
});

test("a busy unit's pending task stays pending (systemd single worker per unit)", async () => {
	const { dir, cleanup } = tmp();
	const spawned: WorkerSpec[] = [];
	const p = await plane(dir, spawned);
	try {
		const d = p.store.delegate({ fromUnit: "ceo", toUnit: "ops", goal: "g", contract: { schema: { type: "object" } }, budget: { tokens: 100, costUsd: 1, wallClockSec: 10 } });
		assert.ok(d.ok);
		const disp = new Dispatcher({ store: p.store, socketPath: join(dir, "c.sock"), spawner: (s) => void spawned.push(s), isUnitBusy: () => true });
		assert.deepEqual(await disp.tick(), []);
		assert.equal(p.store.getTask(d.taskId)?.status, "pending");
		assert.equal(spawned.length, 0);
	} finally {
		await p.stop();
		cleanup();
	}
});

test("smoke probe (scripts/smoke-unit-probe.mjs) hellos + completes its task over its own unit socket", async () => {
	const { dir, cleanup } = tmp();
	const p = await plane(dir);
	try {
		const contract = { schema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string", minLength: 1 } } } };
		const d = p.store.delegate({ fromUnit: "ceo", toUnit: "ops", goal: "g", contract, budget: { tokens: 100, costUsd: 1, wallClockSec: 10 } });
		assert.ok(d.ok);
		p.store.startTask(d.taskId);
		const state = join(dir, "state");
		mkdirSync(join(state, "agent-dir"), { recursive: true, mode: 0o700 });
		chmodSync(state, 0o700);
		const probe = join(import.meta.dirname, "../../../scripts/smoke-unit-probe.mjs");
		const env = {
			PATH: process.env.PATH ?? "",
			ORG_UNIT_ID: "ops",
			ORG_TASK_ID: d.taskId,
			ORG_CONTROL_SOCKET: p.unitSocketOf("ops")!,
			ORG_UNIT_MANIFEST: "/srv/org/ops/unit.json",
			PI_CODING_AGENT_DIR: join(state, "agent-dir"),
		};
		const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) =>
			execFile(process.execPath, [probe, "--uid", String(process.getuid!()), "--complete"], { env }, (e, so, se) => (e ? reject(new Error(`${e.message}\n${so}\n${se}`)) : resolve({ stdout: so }))),
		);
		assert.match(stdout, /PROBE OK/);
		assert.equal(p.store.getTask(d.taskId)?.status, "done");
	} finally {
		await p.stop();
		cleanup();
	}
});
