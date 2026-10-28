/**
 * systemd unit generators (SPEC S6 / ADR-0002).
 *
 * The OS user or VM — not the Pi hook — is the trust boundary. These pure
 * functions render the deployment artifacts that make that boundary real:
 *   - one hardened transient service per unit worker, running as its own
 *     dedicated Unix user (`pi-u-<id>`) with a read-only system and a write
 *     scope narrowed to the unit's workspace;
 *   - the long-running `pi-control` daemon that owns control.db and the socket.
 *
 * Everything here is text generation with no I/O so it is fully unit-testable;
 * the smoke-test script installs the rendered files on a Linux VM.
 */

import { ENV_DB, ENV_DURABLE_DIR, ENV_SOCKET, ENV_TASK, ENV_TOKEN, ENV_UNIT } from "pi-agentic-control-plane";

/**
 * Syscall filter shared by every unit. Node calls setrlimit(RLIMIT_NOFILE) at
 * startup, but @resources is denied, so setrlimit/prlimit64 are re-allowed by a
 * later line (systemd applies SystemCallFilter lines in order). EPERM makes any
 * other missed syscall fail with an error instead of killing the process (SIGSYS).
 */
const SYSCALL_LINES = [
	"SystemCallFilter=@system-service",
	"SystemCallFilter=~@privileged @resources",
	"SystemCallFilter=setrlimit prlimit64",
	"SystemCallErrorNumber=EPERM",
].join("\n");

/** A unit id must be a safe token before it becomes a Unix user / unit name. */
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

function assertSafeId(id: string): void {
	if (!SAFE_ID.test(id)) throw new Error(`unsafe unit id for systemd: ${JSON.stringify(id)}`);
}

/** Dedicated Unix user for a unit worker. */
export function unitUser(id: string): string {
	assertSafeId(id);
	return `pi-u-${id}`;
}

/** systemd service name for a unit worker (one-shot per task launch). */
export function unitServiceName(id: string, mode: "pi" | "durable" = "pi"): string {
	assertSafeId(id);
	return mode === "durable" ? `pi-durable@${id}.service` : `pi-unit@${id}.service`;
}

export interface WorkerUnitOptions {
	/** Org unit id (also the user suffix and service instance). */
	unitId: string;
	/** Filesystem workspace the worker runs in and may write to. */
	workspace: string;
	/** This unit's OWN control socket (`<unitSocketDir>/<id>.sock`); identity = socket (ADR-0003). */
	socketPath: string;
	/** Absolute path of the unit's unit.json (ORG_UNIT_MANIFEST). */
	manifestPath: string;
	/** Root-owned per-unit EnvironmentFile (`<manifestDir>/<id>/secrets.env`, 0640 root:pi-u-<id>) carrying the manifest `secrets` env vars; optional (`-` prefix). */
	secretsFile?: string;
	/** Per-unit state dir `<unitsRoot>/<id>` (0700, owned by this unit's user); writable; holds `agent-dir`. */
	stateDir: string;
	/** The control plane's state dir (control.db, shared socket): the worker is denied it entirely. */
	controlStateDir: string;
	/** Per-task EnvironmentFile the control plane writes (ORG_TASK_ID, ...). Read by systemd, not the worker. */
	taskEnvFile: string;
	/** Every OTHER unit: their state dir and socket are made inaccessible to this worker (defence in depth over uid/mode). */
	otherUnits?: ReadonlyArray<{ id: string; stateDir: string; socketPath: string }>;
	/** Whether this unit is allowed to run bash (holds tool:bash). Exports ORG_BWRAP=1. */
	allowBash: boolean;
	/** bwrap binary exported as ORG_BWRAP_BIN to bash units. */
	bwrapBin?: string;
	/**
	 * Absolute path to the `pi` launcher. Default: /usr/local/bin/pi. Only
	 * usable when the unit holds tool:bash: the managed-install launcher is a
	 * `#!/bin/sh` script, which cannot exec once shell paths are inaccessible.
	 */
	piBin?: string;
	/**
	 * Absolute path to Pi's `cli.js` (e.g. <install>/node_modules/@earendil-works/
	 * pi-coding-agent/dist/cli.js). ExecStart becomes `<nodeBin> <piCli>`, with no
	 * shell in the chain. REQUIRED for units without tool:bash.
	 */
	piCli?: string;
	/** Absolute path to the node binary used with piCli. Default: /usr/bin/node. */
	nodeBin?: string;
	/** Worker launch mode (default `pi`). `durable` renders `pi-durable@<id>.service`. */
	mode?: "pi" | "durable";
	/** Absolute path to the pi-agentic-durable worker script (its bin js). REQUIRED for mode=durable. */
	durableBin?: string;
}

/**
 * Render a hardened per-unit worker service. The directives enforce the OS
 * boundary ADR-0002 relies on: no privilege escalation, a read-only system,
 * a private /tmp and /dev, and a write scope limited to the unit's workspace
 * and its own 0700 state dir. Other units' state dirs/sockets and the control
 * state dir are inaccessible. A unit without the bash grant additionally gets
 * a syscall allowlist that blocks process creation, so even a hook bypass
 * cannot shell out.
 */
export function renderWorkerUnit(opts: WorkerUnitOptions): string {
	const mode = opts.mode ?? "pi";
	assertSafeId(opts.unitId);
	assertSafePath(opts.workspace, "workspace");
	assertSafePath(opts.socketPath, "socketPath");
	assertSafePath(opts.manifestPath, "manifestPath");
	// The manifest (secrets list, grants) must not be editable by the worker: refuse unit-writable locations.
	for (const w of [opts.workspace, opts.stateDir]) {
		if (isUnder(opts.manifestPath, w)) throw new Error(`manifestPath ${opts.manifestPath} is in a unit-writable location (${w}); use a root-owned dir`);
	}
	if (opts.secretsFile !== undefined) assertSafePath(opts.secretsFile, "secretsFile");
	assertSafePath(opts.stateDir, "stateDir");
	assertSafePath(opts.controlStateDir, "controlStateDir");
	assertSafePath(opts.taskEnvFile, "taskEnvFile");
	for (const [what, p] of [
		["workspace", opts.workspace],
		["stateDir", opts.stateDir],
		["socketPath", opts.socketPath],
		["taskEnvFile", opts.taskEnvFile],
	] as const) {
		if (isUnder(p, opts.controlStateDir)) throw new Error(`${what} ${p} is inside the control state dir ${opts.controlStateDir}, which workers are denied`);
	}
	const user = unitUser(opts.unitId);
	const others = (opts.otherUnits ?? []).filter((o) => o.id !== opts.unitId);
	for (const o of others) {
		assertSafeId(o.id);
		assertSafePath(o.stateDir, "otherUnits.stateDir");
		assertSafePath(o.socketPath, "otherUnits.socketPath");
		// Hiding another unit's dir must never hide this unit's own state.
		if (isUnder(opts.stateDir, o.stateDir) || isUnder(o.stateDir, opts.stateDir)) throw new Error(`unit state dirs overlap: ${opts.stateDir} vs ${o.stateDir}`);
		if (o.socketPath === opts.socketPath) throw new Error(`units ${opts.unitId} and ${o.id} share a socket path`);
	}
	const agentDir = `${opts.stateDir.replace(/\/+$/, "")}/agent-dir`;
	let execStart: string;
	if (mode === "durable") {
		// The durable worker is a node script (pi-agentic-durable bin): no shell
		// or launcher is involved, so it needs neither piCli nor piBin.
		if (opts.durableBin === undefined) throw new Error("durable mode requires durableBin (the pi-agentic-durable worker .js)");
		const nodeBin = opts.nodeBin ?? "/usr/bin/node";
		assertSafePath(nodeBin, "nodeBin");
		assertSafePath(opts.durableBin, "durableBin");
		if (!/\.[cm]?js$/.test(opts.durableBin)) throw new Error(`durableBin must be a node script (.js/.mjs/.cjs): ${opts.durableBin}`);
		execStart = `${nodeBin} ${opts.durableBin}`;
	} else if (opts.piCli !== undefined) {
		if (opts.piBin !== undefined) throw new Error("piBin and piCli are mutually exclusive");
		const nodeBin = opts.nodeBin ?? "/usr/bin/node";
		assertSafePath(nodeBin, "nodeBin");
		assertSafePath(opts.piCli, "piCli");
		if (!/\.[cm]?js$/.test(opts.piCli)) throw new Error(`piCli must be a node script (.js/.mjs/.cjs): ${opts.piCli}`);
		execStart = `${nodeBin} ${opts.piCli}`;
	} else {
		// A launcher may be a #!/bin/sh script; with shell paths inaccessible it
		// could never exec, so fail closed instead of rendering a dead unit.
		if (!opts.allowBash) {
			throw new Error(`unit ${opts.unitId} has no tool:bash, so shells are inaccessible: set piCli (ORG_PI_CLI) to Pi's cli.js instead of a launcher`);
		}
		const piBin = opts.piBin ?? "/usr/local/bin/pi";
		assertSafePath(piBin, "piBin");
		execStart = piBin;
	}
	// Static identity of the worker. The control db path and any bearer token are
	// deliberately absent: identity is the per-unit socket, and the worker never
	// opens control.db. ORG_TASK_ID arrives via EnvironmentFile= (per-task).
	const env: Array<[string, string]> = [
		[ENV_UNIT, opts.unitId],
		[ENV_SOCKET, opts.socketPath],
		["ORG_UNIT_MANIFEST", opts.manifestPath],
		["PI_CODING_AGENT_DIR", agentDir],
		["HOME", opts.stateDir],
		...(mode === "durable" ? [[ENV_DURABLE_DIR, durableDir(opts.stateDir)] as [string, string]] : []),
	];
	if (opts.allowBash) {
		env.push(["ORG_BWRAP", "1"]);
		if (opts.bwrapBin) {
			assertSafePath(opts.bwrapBin, "bwrapBin");
			env.push(["ORG_BWRAP_BIN", opts.bwrapBin]);
		}
	}
	const envLines = env.map(([k, v]) => `Environment=${k}=${quoteEnv(v, false)}`).join("\n");

	// The worker is a Node process: libuv needs clone/clone3 for its thread
	// pool and V8 needs W+X pages for JIT, so neither @process nor
	// MemoryDenyWriteExecute can be used. Privileged/resource syscalls are
	// denied for every unit. A unit without the bash grant additionally cannot
	// see any shell, so a hook bypass has nothing to exec (execve itself cannot
	// be filtered: the filter is installed before systemd execs ExecStart).
	const syscallLines = SYSCALL_LINES;
	const noShell = opts.allowBash ? "" : `\nInaccessiblePaths=${SHELL_PATHS.map((x) => `-${x}`).join(" ")}`;
	const hidden = [opts.controlStateDir, ...others.flatMap((o) => [o.stateDir, o.socketPath])];
	const hiddenLine = `InaccessiblePaths=${hidden.map((x) => `-${x}`).join(" ")}`;

	return `# Generated by agentic-pi (SPEC S6). Do not edit by hand.
[Unit]
Description=agentic-pi worker for unit ${opts.unitId}
After=pi-control.service
Requires=pi-control.service

[Service]
Type=simple
User=${user}
Group=${user}
WorkingDirectory=${opts.workspace}
${envLines}
EnvironmentFile=${opts.taskEnvFile}${opts.secretsFile !== undefined ? `\nEnvironmentFile=-${opts.secretsFile}` : ""}
ExecStart=${execStart}${mode === "durable" ? "" : " --mode json"}

# --- OS boundary (ADR-0002) ---
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
# No MemoryDenyWriteExecute: V8's JIT needs W+X memory.
RemoveIPC=yes
# Write scope is the unit workspace and its own 0700 state dir (agent-dir); everything else is read-only.
ReadWritePaths=${opts.workspace} ${opts.stateDir}
# The control plane's state dir (control.db, shared socket), every other unit's state dir and socket: not reachable.
${hiddenLine}
# Only this unit's own socket is the channel out (OS perms: owner pi-control, group ${user}, 0660).
RestrictAddressFamilies=AF_UNIX
${syscallLines}
CapabilityBoundingSet=
AmbientCapabilities=${noShell}
`;
}

export interface ControlUnitOptions {
	/** Absolute path to control.db. */
	controlDb: string;
	/** Absolute path to the shared (token/admin) control socket; lives in stateDir, which workers cannot reach. */
	socketPath: string;
	/** Directory holding control.db + the shared socket (the only persistent writable path). */
	stateDir: string;
	/**
	 * Per-unit socket directory, `/run/<name>`: systemd creates it as the
	 * RuntimeDirectory (mode 0711: traverse-only for workers). One `<id>.sock` per
	 * unit inside, owner pi-control, group pi-u-<id>, mode 0660 (ADR-0003).
	 */
	unitSocketDir: string;
	/** Unit ids whose `pi-u-<id>` group the control user joins so it can chgrp each unit socket. */
	unitIds: readonly string[];
	/** Worker cwd root (ORG_WORKSPACE_ROOT). */
	workspaceRoot: string;
	/** Per-unit state root (ORG_UNITS_DIR): `<unitsRoot>/<id>/agent-dir`. */
	unitsRoot: string;
	/** Absolute path to the node binary. Default: /usr/bin/node. */
	nodeBin?: string;
	/** Absolute path to control-plane.ts entrypoint. */
	entrypoint: string;
	/** Optional sweep interval override (ms). */
	sweepIntervalMs?: number;
	/** bwrap binary exported to bash units (ORG_BWRAP_BIN). */
	bwrapBin?: string;
	/** Root-owned manifest dir exported as ORG_MANIFEST_DIR (dispatcher/spawners read `<dir>/<id>/{unit.json,secrets.env}`). */
	manifestDir?: string;
	/** Worker launch mode exported as ORG_WORKER_MODE so the dispatcher starts the same unit template the renderer wrote (default: omitted = pi). */
	workerMode?: "pi" | "durable";
}

/** Render the long-running control-plane daemon service (user pi-control). */
export function renderControlUnit(opts: ControlUnitOptions): string {
	const nodeBin = opts.nodeBin ?? "/usr/bin/node";
	assertSafePath(nodeBin, "nodeBin");
	assertSafePath(opts.entrypoint, "entrypoint");
	assertSafePath(opts.stateDir, "stateDir");
	assertSafePath(opts.unitSocketDir, "unitSocketDir");
	assertSafePath(opts.workspaceRoot, "workspaceRoot");
	assertSafePath(opts.unitsRoot, "unitsRoot");
	const runtimeName = /^\/run\/([a-z0-9][a-z0-9-]*)$/.exec(opts.unitSocketDir)?.[1];
	if (!runtimeName) throw new Error(`unitSocketDir must be /run/<name> (a systemd RuntimeDirectory): ${JSON.stringify(opts.unitSocketDir)}`);
	if (isUnder(opts.unitSocketDir, opts.stateDir) || isUnder(opts.stateDir, opts.unitSocketDir)) {
		throw new Error("unitSocketDir and stateDir must not overlap: workers are denied the state dir");
	}
	const groups = opts.unitIds.map(unitUser).join(" ");
	const env: Array<[string, string]> = [
		[ENV_DB, opts.controlDb],
		[ENV_SOCKET, opts.socketPath],
		["ORG_UNIT_SOCKET_DIR", opts.unitSocketDir],
		["ORG_WORKSPACE_ROOT", opts.workspaceRoot],
		["ORG_UNITS_DIR", opts.unitsRoot],
		["ORG_SPAWNER", "systemd"],
	];
	if (opts.bwrapBin) {
		assertSafePath(opts.bwrapBin, "bwrapBin");
		env.push(["ORG_BWRAP_BIN", opts.bwrapBin]);
	}
	if (opts.manifestDir !== undefined) {
		assertSafePath(opts.manifestDir, "manifestDir");
		env.push(["ORG_MANIFEST_DIR", opts.manifestDir]);
	}
	if (opts.sweepIntervalMs !== undefined) env.push(["ORG_SWEEP_INTERVAL_MS", String(opts.sweepIntervalMs)]);
	if (opts.workerMode !== undefined) env.push(["ORG_WORKER_MODE", opts.workerMode]);
	const envLines = env.map(([k, v]) => `Environment=${k}=${quoteEnv(v, false)}`).join("\n");

	return `# Generated by agentic-pi (SPEC S6). Do not edit by hand.
[Unit]
Description=agentic-pi control plane
After=network.target

[Service]
Type=simple
User=pi-control
Group=pi-control
# Sockets are created before chmod/chown: never let them exist group/world-accessible.
UMask=0077
${groups ? `SupplementaryGroups=${groups}\n` : ""}StateDirectory=${baseName(opts.stateDir)}
RuntimeDirectory=${runtimeName}
RuntimeDirectoryMode=0711
RuntimeDirectoryPreserve=yes
${envLines}
ExecStart=${nodeBin} ${opts.entrypoint}
Restart=on-failure
RestartSec=2

# --- hardening ---
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
RemoveIPC=yes
ReadWritePaths=${opts.stateDir} ${opts.unitSocketDir}
RestrictAddressFamilies=AF_UNIX
# Node: no MemoryDenyWriteExecute (V8 JIT) and no @process (libuv threads).
${SYSCALL_LINES}
CapabilityBoundingSet=
AmbientCapabilities=
`;
}

/**
 * sysusers.d fragment: the control user plus one `pi-u-<id>` user+group per unit,
 * with the control user a member of each unit group (so it can chgrp unit sockets).
 */
export function renderSysusers(unitIds: readonly string[], stateDir: string): string {
	assertSafePath(stateDir, "stateDir");
	const lines = ["# Generated by agentic-pi. Do not edit by hand.", `u pi-control - "agentic-pi control plane" ${stateDir} /usr/sbin/nologin`];
	for (const id of unitIds) {
		const user = unitUser(id);
		lines.push(`u ${user} - "agentic-pi unit ${id}" /nonexistent /usr/sbin/nologin`);
		lines.push(`m pi-control ${user}`);
	}
	return `${lines.join("\n")}\n`;
}

/** pi-durable storage + lock dir inside a unit's 0700 state dir (ORG_DURABLE_DIR in durable mode). */
export function durableDir(stateDir: string): string {
	assertSafePath(stateDir, "stateDir");
	return `${stateDir.replace(/\/+$/, "")}/durable`;
}

/** Per-unit state dir for a unit: `<unitsRoot>/<id>` (0700, owned by pi-u-<id>). */
export function unitStateDir(unitsRoot: string, id: string): string {
	assertSafeId(id);
	assertSafePath(unitsRoot, "unitsRoot");
	return `${unitsRoot.replace(/\/+$/, "")}/${id}`;
}

/**
 * Root-owned manifest layout for a unit: `<manifestDir>/<id>/unit.json` (0644 root:root,
 * written by render) and `<manifestDir>/<id>/secrets.env` (0640 root:pi-u-<id>, operator-filled).
 */
export function manifestPathOf(manifestDir: string, id: string): string {
	assertSafeId(id);
	assertSafePath(manifestDir, "manifestDir");
	return `${manifestDir.replace(/\/+$/, "")}/${id}/unit.json`;
}
export function secretsFileOf(manifestDir: string, id: string): string {
	assertSafeId(id);
	assertSafePath(manifestDir, "manifestDir");
	return `${manifestDir.replace(/\/+$/, "")}/${id}/secrets.env`;
}

/**
 * tmpfiles.d fragment creating the per-unit state tree: `<unitsRoot>` traverse-only
 * (0711), each `<unitsRoot>/<id>` 0700 owned by pi-u-<id>, and its `agent-dir`
 * (PI_CODING_AGENT_DIR) 0700 likewise. With `manifestDir`, also the root-owned
 * manifest tree (0755 dirs; `f` creates an empty `secrets.env` 0640 root:pi-u-<id>
 * if absent and never overwrites the operator's content). With `workspaces`, each
 * `<workspace>` becomes root:pi-u-<id> 1770 (sticky: the unit cannot rename/remove entries it
 * does not own) and `<workspace>/.pi` + `<workspace>/.agents` are root:root 0755, so the unit
 * user can never create or modify project resources (extensions/skills), via bash or write/edit.
 */
export function renderTmpfiles(unitIds: readonly string[], unitsRoot: string, opts: { durable?: boolean; manifestDir?: string; workspaces?: Readonly<Record<string, string>> } = {}): string {
	assertSafePath(unitsRoot, "unitsRoot");
	const lines = ["# Generated by agentic-pi. Do not edit by hand.", `d ${unitsRoot} 0711 root root -`];
	if (opts.manifestDir !== undefined) {
		assertSafePath(opts.manifestDir, "manifestDir");
		lines.push(`d ${opts.manifestDir.replace(/\/+$/, "")} 0755 root root -`);
	}
	for (const id of unitIds) {
		const user = unitUser(id);
		const dir = unitStateDir(unitsRoot, id);
		lines.push(`d ${dir} 0700 ${user} ${user} -`);
		lines.push(`d ${dir}/agent-dir 0700 ${user} ${user} -`);
		if (opts.durable) lines.push(`d ${durableDir(dir)} 0700 ${user} ${user} -`);
		if (opts.manifestDir !== undefined) {
			lines.push(`d ${manifestPathOf(opts.manifestDir, id).replace(/\/unit\.json$/, "")} 0755 root root -`);
			lines.push(`f ${secretsFileOf(opts.manifestDir, id)} 0640 root ${user} -`);
		}
		const ws = opts.workspaces?.[id];
		if (ws !== undefined) {
			assertSafePath(ws, "workspace");
			const w = ws.replace(/\/+$/, "");
			lines.push(`d ${w} 1770 root ${user} -`);
			lines.push(`d ${w}/.pi 0755 root root -`);
			lines.push(`d ${w}/.agents 0755 root root -`);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** polkit rule letting ONLY the control user start `pi-unit@<id>.service` / `pi-durable@<id>.service` (no stop/restart/other units). */
export function renderPolkitRule(): string {
	return `// Generated by agentic-pi. Do not edit by hand.
polkit.addRule(function (action, subject) {
	if (action.id !== "org.freedesktop.systemd1.manage-units" || subject.user !== "pi-control") return polkit.Result.NOT_HANDLED;
	var unit = action.lookup("unit");
	if (action.lookup("verb") === "start" && /^pi-(unit|durable)@[a-z0-9][a-z0-9-]*\\.service$/.test(unit)) return polkit.Result.YES;
	return polkit.Result.NOT_HANDLED;
});
`;
}

/** True when `p` is `dir` or lives below it. */
function isUnder(p: string, dir: string): boolean {
	const d = dir.replace(/\/+$/, "");
	return p === d || p.startsWith(`${d}/`);
}

/** Shells a no-bash unit must not be able to reach. */
const SHELL_PATHS = ["/bin/sh", "/bin/bash", "/bin/dash", "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/dash"] as const;

/**
 * A path used in an unquoted directive (WorkingDirectory=, ReadWritePaths=,
 * ExecStart=, StateDirectory=): absolute, normalised, and free of whitespace,
 * quotes, backslashes, `%`, `$` and control characters, because systemd splits
 * or expands all of those. Refusing is the only safe option.
 */
function assertSafePath(p: string, what: string): void {
	if (!/^\/[A-Za-z0-9_.,:+@=\/-]*$/.test(p) || p.split("/").some((s) => s === ".." || s === ".")) {
		throw new Error(`unsafe ${what} for systemd: ${JSON.stringify(p)}`);
	}
}

/** Quote a value for an Environment= line; control characters (newlines) are refused. */
function quoteEnv(v: string, allowSpecifier: boolean): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
	if (/[\x00-\x1f\x7f]/.test(v)) throw new Error(`control character in systemd value: ${JSON.stringify(v)}`);
	const esc = allowSpecifier ? v : v.replace(/%/g, "%%");
	if (/^[A-Za-z0-9_./:%-]+$/.test(esc)) return esc;
	return `"${esc.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function baseName(p: string): string {
	const parts = p.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] ?? p;
}
