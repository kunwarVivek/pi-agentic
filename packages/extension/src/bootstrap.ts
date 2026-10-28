/**
 * Shared bootstrap for the org extensions. Opens the ControlClient lazily
 * (never in the factory — ADR-0001) and exposes it to the individual extension
 * installers.
 *
 * Fail closed (SPEC FR1/FR2): outside the org the extension is inert ONLY when
 * `AGENTIC_PI_DEV=1`. Otherwise a missing/partial configuration, an invalid
 * `unit.json`, or a control plane that cannot be reached leaves `client` null
 * with a visible `failure` reason, so every tool call is blocked.
 *
 * Transport (ADR-0003): deployed workers set ORG_CONTROL_SOCKET and talk to the
 * control plane over it, never opening control.db. The in-process store client
 * (ORG_CONTROL_DB) is a dev-only fallback, honoured only with AGENTIC_PI_DEV=1.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Manifest, canonicalizePathGrants, parseManifest, pathMatches } from "pi-agentic-core";
import {
	ENV_DB,
	ENV_SOCKET,
	ENV_TASK,
	ENV_TOKEN,
	ENV_UNIT,
	LocalControlClient,
	SocketControlClient,
	type ControlClient,
	type UnitConfig,
} from "pi-agentic-control-plane";
import { nearestRealpath } from "./org-policy.ts";
import type { ExtensionAPI } from "./pi-api.ts";

/** Absolute path to the unit's unit.json (default `<cwd>/unit.json`). */
export const ENV_MANIFEST = "ORG_UNIT_MANIFEST";
/** `1` = dev mode: inert without org env, and the in-process control.db client is allowed. */
export const ENV_DEV = "AGENTIC_PI_DEV";
/** `1` = route the bash tool through bubblewrap (rendered by deploy for bash units). */
export const ENV_BWRAP = "ORG_BWRAP";
export const ENV_BWRAP_BIN = "ORG_BWRAP_BIN";
/** `1` = explicitly allow a granted bash call to run without the OS sandbox. */
export const ENV_UNSANDBOXED_BASH = "AGENTIC_PI_UNSANDBOXED_BASH";

/** How a granted shell tool call is executed. */
export type ShellMode = { mode: "bwrap"; bwrapBin: string | undefined } | { mode: "unsandboxed" } | { mode: "blocked" };

export interface OrgRuntime {
	enabled: boolean;
	unitId: string;
	taskId: string | null;
	/** Non-null once connected (session_start, or earlier via connect()). */
	client: ControlClient | null;
	/** The validated unit.json, once loaded (set before the client connects). */
	manifest: Manifest | null;
	/** Why the runtime cannot gate (config/manifest/connect error); null while healthy. */
	failure: string | null;
	/** How granted shell tools run: bwrap, unsandboxed (dev / explicit opt-in), or blocked. */
	shell: ShellMode;
	/** Literal values of the manifest's `secrets` env vars (empty until the manifest loads). */
	secretValues(): string[];
	/** AGENTIC_PI_DEV=1: relaxed dev session (no project-resource write protection, manifest may sit in the workspace). */
	dev: boolean;
	/**
	 * Connect now if not yet connected (idempotent; concurrent callers share one
	 * attempt). Hooks Pi fires before session_start, such as project_trust, use
	 * this. Rejects on failure, leaving `client` null so every gate fails closed.
	 */
	connect(): Promise<ControlClient>;
}

export interface BootstrapOptions {
	env?: Record<string, string | undefined>;
	/** Directory for the default manifest path (`<cwd>/unit.json`). Defaults to process.cwd(). */
	cwd?: string;
	/** Reads the manifest file as text (tests inject). Defaults to fs.readFileSync utf8. */
	readManifest?: (path: string) => string;
	/** Client factory (tests inject a fake). Defaults to {@link openControlClient}. */
	openClient?: (config: UnitConfig) => ControlClient | Promise<ControlClient>;
	/** Realpath resolver for the manifest-location check (tests inject). Defaults to nearestRealpath. */
	realpath?: (path: string) => string;
}

/** Socket client when a socket is configured (deployed workers), else the dev in-process store. */
export async function openControlClient(config: UnitConfig): Promise<ControlClient> {
	if (config.socketPath) {
		const client = new SocketControlClient({
			unitId: config.unitId,
			taskId: config.taskId,
			socketPath: config.socketPath,
			...(config.token ? { token: config.token } : {}),
		});
		await client.connectAndHello();
		return client;
	}
	return LocalControlClient.open({ unitId: config.unitId, taskId: config.taskId, dbPath: config.dbPath });
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const nonEmpty = (v: string | undefined): string | null => (v && v.length > 0 ? v : null);

export function resolveShell(env: Record<string, string | undefined>, dev: boolean): ShellMode {
	if (env[ENV_BWRAP] === "1") return { mode: "bwrap", bwrapBin: nonEmpty(env[ENV_BWRAP_BIN]) ?? undefined };
	if (dev || env[ENV_UNSANDBOXED_BASH] === "1") return { mode: "unsandboxed" };
	return { mode: "blocked" };
}

/**
 * Create the shared runtime and register session lifecycle handlers that open,
 * refresh and close the control client. Returns the runtime object, which the
 * extension installers read after connecting.
 */
export function bootstrap(pi: ExtensionAPI, opts: BootstrapOptions = {}): OrgRuntime {
	const env = opts.env ?? process.env;
	const dev = env[ENV_DEV] === "1";
	const unitId = nonEmpty(env[ENV_UNIT]);
	const dbPath = nonEmpty(env[ENV_DB]);
	const socketPath = nonEmpty(env[ENV_SOCKET]);
	const manifestPath = resolve(nonEmpty(env[ENV_MANIFEST]) ?? join(opts.cwd ?? process.cwd(), "unit.json"));
	const readManifest = opts.readManifest ?? ((p: string) => readFileSync(p, "utf8"));
	const open = opts.openClient ?? openControlClient;
	const realpath = opts.realpath ?? nearestRealpath;

	let configFailure: string | null = null;
	if (!unitId && !dbPath && !socketPath) {
		if (dev) {
			// Plain dev session outside the org: stay out of the way.
			return inertRuntime();
		}
		configFailure = `no org configuration (${ENV_UNIT}, ${ENV_SOCKET}); refusing to run ungoverned (set ${ENV_DEV}=1 for a dev session)`;
	} else if (!unitId) {
		configFailure = `${ENV_UNIT} is required`;
	} else if (!socketPath && !dev) {
		configFailure = `${ENV_SOCKET} is required (direct ${ENV_DB} access is dev-only: ${ENV_DEV}=1)`;
	} else if (!socketPath && !dbPath) {
		configFailure = `${ENV_SOCKET} or (dev) ${ENV_DB} is required`;
	}

	const config: UnitConfig = {
		unitId: unitId ?? "",
		dbPath: dbPath ?? "",
		taskId: nonEmpty(env[ENV_TASK]),
		enabled: true,
		socketPath,
		token: nonEmpty(env[ENV_TOKEN]),
	};

	let connecting: Promise<ControlClient> | null = null;
	let fatal = configFailure !== null;
	let secrets: string[] = [];
	const runtime: OrgRuntime = {
		enabled: true,
		unitId: config.unitId,
		taskId: config.taskId,
		client: null,
		manifest: null,
		failure: configFailure,
		shell: resolveShell(env, dev),
		secretValues: () => secrets,
		dev,
		connect() {
			if (fatal) return Promise.reject(new Error(runtime.failure ?? "org extensions are not configured"));
			if (runtime.client) return Promise.resolve(runtime.client);
			connecting ??= (async () => {
				if (!runtime.manifest) {
					try {
						runtime.manifest = loadManifest(readManifest, manifestPath, config.unitId);
						if (!dev) assertManifestOutsideWritable(runtime.manifest, manifestPath, realpath);
					} catch (e) {
						// An invalid or unit-writable manifest never heals within a session: stay closed.
						runtime.manifest = null;
						fatal = true;
						throw e;
					}
					secrets = secretValuesOf(runtime.manifest, env, authSecretValues(env));
				}
				const client = await open(config);
				runtime.client = client;
				runtime.failure = null;
				return client;
			})().catch((e: unknown) => {
				connecting = null;
				runtime.failure = errMessage(e);
				throw e;
			});
			return connecting;
		},
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			await runtime.connect();
		} catch (e) {
			try {
				ctx.ui?.notify?.(`org: control plane unavailable, all tools blocked: ${errMessage(e)}`, "error");
			} catch {
				// Best effort: the tool_call gate is what enforces.
			}
			throw e;
		}
	});
	// The socket client serves PDP reads from a cached snapshot; refresh it each
	// turn so grants, task status and remaining budget track the control plane.
	// A failed refresh drops the client so every gate fails closed (no stale grants).
	pi.on("turn_start", async () => {
		const client = runtime.client;
		if (!client) return;
		try {
			await client.refresh();
		} catch (e) {
			runtime.client = null;
			connecting = null;
			runtime.failure = `control plane refresh failed: ${errMessage(e)}`;
			throw e;
		}
	});
	pi.on("session_shutdown", async () => {
		const client = runtime.client;
		runtime.client = null;
		connecting = null;
		await client?.close();
	});
	return runtime;
}

function inertRuntime(): OrgRuntime {
	return {
		enabled: false,
		unitId: "",
		taskId: null,
		client: null,
		manifest: null,
		failure: null,
		shell: { mode: "unsandboxed" },
		secretValues: () => [],
		dev: true,
		connect: () => Promise.reject(new Error("org extensions are not enabled")),
	};
}

/** Read + validate unit.json; the manifest id must be the unit this worker claims to be (FR1). */
export function loadManifest(read: (path: string) => string, path: string, unitId: string): Manifest {
	let raw: string;
	try {
		raw = read(path);
	} catch (e) {
		throw new Error(`cannot read unit manifest ${path}: ${errMessage(e)}`);
	}
	let manifest: Manifest;
	try {
		manifest = parseManifest(JSON.parse(raw));
	} catch (e) {
		throw new Error(`invalid unit manifest ${path}: ${errMessage(e)}`);
	}
	if (manifest.id !== unitId) {
		throw new Error(`unit manifest ${path} is for '${manifest.id}', but ${ENV_UNIT} is '${unitId}'`);
	}
	return manifest;
}

/** Non-empty values of the manifest-declared secret env vars plus any `extra` credentials (longest first). */
export function secretValuesOf(manifest: Manifest, env: Record<string, string | undefined>, extra: readonly string[] = []): string[] {
	const values = manifest.secrets.map((name) => env[name]).filter((v): v is string => typeof v === "string" && v.length > 0);
	return [...new Set([...values, ...extra])].sort((a, b) => b.length - a.length);
}

/** Credential strings shorter than this are not redacted literally (they would shred ordinary text). */
const MIN_AUTH_SECRET = 8;

/**
 * Every string value in `$PI_CODING_AGENT_DIR/auth.json` (read once; absent or unparsable = none).
 * The worker can read the file through Pi itself, so its values must never leave in a tool result.
 */
export function authSecretValues(env: Record<string, string | undefined>, read: (path: string) => string = (p) => readFileSync(p, "utf8")): string[] {
	const dir = nonEmpty(env.PI_CODING_AGENT_DIR);
	if (!dir) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(read(join(dir, "auth.json")));
	} catch {
		return [];
	}
	const out: string[] = [];
	const walk = (v: unknown): void => {
		if (typeof v === "string") {
			if (v.length >= MIN_AUTH_SECRET) out.push(v);
		} else if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === "object") Object.values(v).forEach(walk);
	};
	walk(parsed);
	return out;
}

/** §5: the manifest must not live where the unit itself can write (it could clear `secrets`/`trust`). Throws if it does. */
export function assertManifestOutsideWritable(manifest: Manifest, manifestPath: string, realpath: (p: string) => string = nearestRealpath): void {
	const real = realpath(manifestPath);
	const rw = canonicalizePathGrants(
		manifest.grants.filter((g) => g.kind === "path" && g.mode === "rw"),
		realpath,
	);
	if (rw.some((g) => g.kind === "path" && pathMatches(g.pattern, real))) {
		throw new Error(`unit manifest ${manifestPath} is inside a writable path grant of the unit; refusing (set ${ENV_DEV}=1 for dev)`);
	}
}
