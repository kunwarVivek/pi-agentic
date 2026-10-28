/**
 * Worker spawners (ADR-0002/0003). A worker MUST run as the unit's own OS user
 * with a minimal, allowlisted environment; the control plane's environment
 * (admin token path, db path, secrets) never reaches it.
 *
 *   - systemd (production default): hand the launch to the rendered
 *     `pi-unit@<id>.service` template (User=pi-u-<id>, full hardening). The
 *     per-task variables go through a mode-600 EnvironmentFile the control user
 *     writes and systemd (root) reads.
 *   - uid: when the control process is root, spawn directly with the unit's
 *     uid/gid and the allowlisted env (no systemd hardening; fallback only).
 *   - dev: spawn as the current user. Explicit opt-in only (AGENTIC_PI_DEV=1).
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { UNIT_USER_PREFIX } from "./auth.ts";
import { DURABLE_WORKER_BIN, ENV_DURABLE_DIR, type WorkerSpawner, type WorkerSpec } from "./dispatcher.ts";

/** Env keys a production worker may receive from the dispatcher. Everything else is dropped. */
export const WORKER_ENV_ALLOWLIST: readonly string[] = [
	"ORG_UNIT_ID",
	"ORG_TASK_ID",
	"ORG_CONTROL_SOCKET",
	"ORG_UNIT_MANIFEST",
	"ORG_BWRAP",
	"ORG_BWRAP_BIN",
	ENV_DURABLE_DIR,
	"PI_CODING_AGENT_DIR",
];

/** Additional keys only the explicit dev spawner forwards. */
const DEV_ENV_KEYS: readonly string[] = ["ORG_CONTROL_DB", "ORG_UNIT_TOKEN"];

const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * Build a worker's environment from scratch: allowlisted ORG_* keys from the
 * spec plus a fixed PATH/HOME. NEVER spreads `process.env`.
 */
export function buildWorkerEnv(spec: WorkerSpec, opts: { dev?: boolean; home?: string; secrets?: Record<string, string> } = {}): Record<string, string> {
	const out: Record<string, string> = { PATH: SAFE_PATH, HOME: opts.home ?? spec.env.PI_CODING_AGENT_DIR ?? spec.cwd };
	const keys = opts.dev ? [...WORKER_ENV_ALLOWLIST, ...DEV_ENV_KEYS, "AGENTIC_PI_DEV"] : WORKER_ENV_ALLOWLIST;
	for (const k of keys) {
		const v = spec.env[k];
		if (v !== undefined) out[k] = v;
	}
	if (opts.dev) out.AGENTIC_PI_DEV = "1";
	// Declared secrets (manifest `secrets`): never override the worker's own wiring.
	for (const [k, v] of Object.entries(opts.secrets ?? {})) if (!(k in out)) out[k] = v;
	return out;
}

/** Dev spawner: current user, allowlisted env + dev keys. Explicit opt-in. */
export function createDevSpawner(opts: { tracker?: WorkerTracker; readSecrets?: (spec: WorkerSpec) => Record<string, string> } = {}): WorkerSpawner {
	if (process.env.AGENTIC_PI_DEV !== "1") {
		throw new Error("the dev worker spawner runs workers as the control-plane user: set AGENTIC_PI_DEV=1 to opt in");
	}
	return (spec) => {
		const [cmd, args] = launchArgv(spec, {});
		const secrets = (opts.readSecrets ?? readUnitSecrets)(spec);
		const child: ChildProcess = spawn(cmd, args, {
			cwd: spec.cwd,
			env: buildWorkerEnv(spec, { dev: true, secrets }),
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		});
		opts.tracker?.track(spec.unit.id, child);
		child.unref();
	};
}

/**
 * Tracks live uid/dev worker processes per unit. A unit with a live worker is busy: its
 * pending tasks (including a just-rejected, re-queued one) wait until the worker exits, so
 * two workers never run the same unit/task at once (the systemd spawner asks systemctl instead).
 */
export class WorkerTracker {
	private readonly live = new Map<string, Set<ChildProcess>>();

	track(unitId: string, child: ChildProcess): void {
		if (child.exitCode !== null || child.signalCode !== null) return;
		let set = this.live.get(unitId);
		if (!set) this.live.set(unitId, (set = new Set()));
		set.add(child);
		const done = (): void => {
			const s = this.live.get(unitId);
			s?.delete(child);
			if (s && s.size === 0) this.live.delete(unitId);
		};
		child.once("exit", done);
		child.once("error", done);
	}

	isBusy(unitId: string): boolean {
		return (this.live.get(unitId)?.size ?? 0) > 0;
	}
}

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Env vars the unit's manifest `secrets` names, with values from the root-owned per-unit
 * `secrets.env` next to its manifest (`<dir of ORG_UNIT_MANIFEST>/secrets.env`, KEY=VALUE lines).
 * Only declared names are forwarded; a missing/unreadable file or manifest yields none; names
 * that would shadow the worker's own wiring (ORG_*, PATH, HOME, PI_*, AGENTIC_PI_*) are refused.
 */
export function readUnitSecrets(spec: WorkerSpec): Record<string, string> {
	const manifestPath = spec.env.ORG_UNIT_MANIFEST;
	if (!manifestPath) return {};
	let declared: string[];
	let text: string;
	try {
		const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { secrets?: unknown };
		declared = Array.isArray(m.secrets) ? m.secrets.filter((s): s is string => typeof s === "string") : [];
		if (declared.length === 0) return {};
		text = readFileSync(join(dirname(manifestPath), "secrets.env"), "utf8");
	} catch {
		return {};
	}
	const want = new Set(declared.filter((n) => SECRET_NAME.test(n) && !/^(ORG_|PI_|AGENTIC_PI_)/.test(n) && n !== "PATH" && n !== "HOME"));
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const k = line.slice(0, eq).trim();
		if (want.has(k)) out[k] = line.slice(eq + 1);
	}
	return out;
}

function launchArgv(spec: WorkerSpec, o: { nodeBin?: string; piCli?: string }): [string, string[]] {
	if (spec.mode === "durable") return [DURABLE_WORKER_BIN, []];
	if (o.piCli) return [o.nodeBin ?? "/usr/bin/node", [o.piCli, "--mode", "json"]];
	return ["pi", ["--mode", "json"]];
}

export interface PasswdEntry {
	uid: number;
	gid: number;
}

/** Look up a user in /etc/passwd format text. Returns null when absent or malformed. */
export function lookupPasswd(text: string, name: string): PasswdEntry | null {
	for (const line of text.split("\n")) {
		const f = line.split(":");
		if (f[0] !== name) continue;
		const uid = Number(f[2]);
		const gid = Number(f[3]);
		if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid, gid };
	}
	return null;
}

/** Look up a group's gid in /etc/group format text. */
export function lookupGroupGid(text: string, name: string): number | null {
	for (const line of text.split("\n")) {
		const f = line.split(":");
		if (f[0] !== name) continue;
		const gid = Number(f[2]);
		if (Number.isInteger(gid)) return gid;
	}
	return null;
}

/** gid of a unit's `pi-u-<id>` group from /etc/group; null if the group does not exist. */
export function unitGroupGid(unitId: string, groupFile = "/etc/group"): number | null {
	return lookupGroupGid(readFileSync(groupFile, "utf8"), `${UNIT_USER_PREFIX}${unitId}`);
}

export interface UidSpawnerOptions {
	/** passwd file to resolve `pi-u-<id>` (default /etc/passwd). */
	passwdFile?: string;
	/** Must be root to setuid; injectable for tests. */
	isRoot?: () => boolean;
	/** Injected `spawn` (tests). */
	spawnFn?: typeof spawn;
	nodeBin?: string;
	piCli?: string;
	/** Secret reader (tests inject). Default: {@link readUnitSecrets}. */
	readSecrets?: (spec: WorkerSpec) => Record<string, string>;
	/** Live-worker tracker so the dispatcher never starts a second worker for a busy unit. */
	tracker?: WorkerTracker;
}

/** Root-only spawner: run the worker as `pi-u-<id>` (uid+gid) with the allowlisted env. */
export function createUidSpawner(opts: UidSpawnerOptions = {}): WorkerSpawner {
	const isRoot = opts.isRoot ?? (() => process.getuid?.() === 0);
	if (!isRoot()) throw new Error("the uid worker spawner needs root to setuid to the unit user; use the systemd spawner instead");
	const spawnFn = opts.spawnFn ?? spawn;
	return (spec) => {
		const user = `${UNIT_USER_PREFIX}${spec.unit.id}`;
		const entry = lookupPasswd(readFileSync(opts.passwdFile ?? "/etc/passwd", "utf8"), user);
		if (!entry || entry.uid === 0) throw new Error(`unit user ${user} does not exist (or is root); refusing to spawn`);
		const [cmd, args] = launchArgv(spec, opts);
		const secrets = (opts.readSecrets ?? readUnitSecrets)(spec);
		const child = spawnFn(cmd, args, {
			cwd: spec.cwd,
			env: buildWorkerEnv(spec, { secrets }),
			uid: entry.uid,
			gid: entry.gid,
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		});
		opts.tracker?.track(spec.unit.id, child);
		child.unref();
	};
}

export type CommandRunner = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const execRunner: CommandRunner = (cmd, args) =>
	new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) })));
	});

export interface SystemdSpawner {
	spawn: WorkerSpawner;
	/** True when the unit's worker service is already (or about to be) running. */
	isBusy(unitId: string): Promise<boolean>;
}

const ENV_VALUE_SAFE = /^[A-Za-z0-9_./:@+=,-]+$/;

/**
 * Production spawner: write the per-task EnvironmentFile and start the rendered
 * `pi-unit@<id>.service` (mode pi) or `pi-durable@<id>.service` (mode durable),
 * which runs as `pi-u-<id>` under the hardened template. The control user needs
 * polkit permission to start those services (rendered by pi-agentic-deploy as
 * 50-agentic-pi.rules). Only ORG_TASK_ID is per-task: ORG_DURABLE_DIR is pinned by
 * the rendered durable unit inside the unit's own state dir (an EnvironmentFile
 * value would override it with a path the worker cannot reach).
 */
export function createSystemdSpawner(opts: { envDir: string; run?: CommandRunner; systemctl?: string }): SystemdSpawner {
	const run = opts.run ?? execRunner;
	const systemctl = opts.systemctl ?? "systemctl";
	mkdirSync(opts.envDir, { recursive: true, mode: 0o700 });
	chmodSync(opts.envDir, 0o700);
	const service = (unitId: string, mode: WorkerSpec["mode"] = "pi"): string => `${mode === "durable" ? "pi-durable" : "pi-unit"}@${unitId}.service`;
	return {
		async isBusy(unitId) {
			// The deployed mode is not known here: a unit is busy if either variant runs.
			for (const mode of ["pi", "durable"] as const) {
				const { stdout } = await run(systemctl, ["show", "--property=ActiveState", "--value", service(unitId, mode)]);
				if (["active", "activating", "deactivating", "reloading"].includes(stdout.trim())) return true;
			}
			return false;
		},
		async spawn(spec) {
			const lines: string[] = [];
			for (const k of ["ORG_TASK_ID"]) {
				const v = spec.env[k];
				if (v === undefined) continue;
				if (!ENV_VALUE_SAFE.test(v)) throw new Error(`unsafe value for ${k}: refusing to write EnvironmentFile`);
				lines.push(`${k}=${v}`);
			}
			const file = join(opts.envDir, `${spec.unit.id}.env`);
			const tmp = `${file}.tmp`;
			writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
			renameSync(tmp, file);
			await run(systemctl, ["start", service(spec.unit.id, spec.mode)]);
		},
	};
}
