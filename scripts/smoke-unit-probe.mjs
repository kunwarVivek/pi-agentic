/**
 * Linux smoke probe (scripts/smoke.sh). Runs INSIDE a real `pi-unit@<id>` worker
 * (the rendered hardened template, ExecStart swapped by a drop-in) or via
 * `runuser -u pi-u-<id>`. Plain .mjs: the worker cannot rely on type stripping
 * flags. It asserts the OS boundary from the worker's point of view, then
 * completes its dispatched task over its OWN per-unit socket.
 *
 *   node smoke-unit-probe.mjs --uid <n> --other-socket <path> --other-dir <path>
 *        --control-db <path> [--complete]
 */
import { connect } from "node:net";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]] : acc), []),
);
const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`PROBE ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
	if (!ok) failures.push(name);
};

/** Send `calls` ([method, params]...) sequentially over ONE connection (hello must come first); resolve all replies. */
const rpc = (path, calls) =>
	new Promise((resolve, reject) => {
		const sock = connect(path);
		const replies = [];
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("error", reject);
		const send = () => sock.write(`${JSON.stringify({ id: replies.length + 1, method: calls[replies.length][0], params: calls[replies.length][1] })}\n`);
		sock.on("data", (c) => {
			buf += c;
			for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
				replies.push(JSON.parse(buf.slice(0, nl)));
				buf = buf.slice(nl + 1);
				if (replies.length === calls.length) {
					sock.destroy();
					return resolve(replies);
				}
				send();
			}
		});
		sock.on("connect", send);
	});
const connectFails = (path) =>
	new Promise((resolve) => {
		const s = connect(path);
		s.on("connect", () => {
			s.destroy();
			resolve(false);
		});
		s.on("error", (e) => resolve(e.code ?? String(e)));
	});
const throws = (fn) => {
	try {
		fn();
		return false;
	} catch (e) {
		return e.code ?? String(e);
	}
};

const unitId = process.env.ORG_UNIT_ID;
const own = process.env.ORG_CONTROL_SOCKET;

check("runs as the unit's OS user", args.uid !== undefined && process.getuid() === Number(args.uid) && process.getuid() !== 0, `uid=${process.getuid()} want=${args.uid}`);
for (const k of ["ORG_CONTROL_DB", "ORG_UNIT_TOKEN", "ORG_ADMIN_TOKEN_FILE"]) check(`env has no ${k}`, process.env[k] === undefined);
check("ORG_UNIT_MANIFEST set", typeof process.env.ORG_UNIT_MANIFEST === "string" && process.env.ORG_UNIT_MANIFEST.endsWith("/unit.json"));
check("ORG_CONTROL_SOCKET is this unit's own socket", own !== undefined && own.endsWith(`/${unitId}.sock`), own);

const helloParams = { version: 1, ...(process.env.ORG_TASK_ID ? { taskId: process.env.ORG_TASK_ID } : {}) };
const [hello] = await rpc(own, [["hello", helloParams]]);
check("hello on own socket authenticates as this unit (no token)", hello.ok === true && hello.result?.unitId === unitId, JSON.stringify(hello).slice(0, 120));

if (args["other-socket"]) {
	const code = await connectFails(args["other-socket"]);
	check("cannot connect to another unit's socket", code !== false, String(code));
}
if (args["other-dir"]) {
	const code = throws(() => readdirSync(args["other-dir"]));
	check("cannot read another unit's state dir", code !== false, String(code));
}
if (args["control-db"]) {
	const code = throws(() => readFileSync(args["control-db"]));
	check("cannot read control.db", code !== false, String(code));
}
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (agentDir) {
	check("own agent-dir is writable", throws(() => { mkdirSync(agentDir, { recursive: true }); writeFileSync(`${agentDir}/probe`, "x"); }) === false);
	check("own state dir is 0700", (statSync(agentDir.replace(/\/agent-dir$/, "")).mode & 0o777) === 0o700);
}

if (failures.length > 0) {
	console.log(`PROBE FAILED: ${failures.join("; ")}`);
	process.exit(1);
}
if (args.complete && process.env.ORG_TASK_ID) {
	const [, h] = await rpc(own, [["hello", helloParams], ["complete_task", { taskId: process.env.ORG_TASK_ID, artifact: { summary: "probe ok" } }]]);
	check("complete_task over own socket", h.ok === true && h.result?.ok === true, JSON.stringify(h).slice(0, 160));
	if (failures.length > 0) process.exit(1);
}
console.log("PROBE OK");
