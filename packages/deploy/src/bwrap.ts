/**
 * bubblewrap bash sandbox (SPEC S6 / ADR-0002).
 *
 * `bash` is denied unless a unit holds the `tool:bash` grant, and a unit with
 * that grant must run its shell under an OS boundary. On Linux that boundary is
 * bubblewrap (`bwrap`): an unprivileged user-namespace sandbox. This module
 * turns a unit's path grants into a `bwrap` argv that:
 *   - unshares every namespace it can (user, pid, ipc, uts, cgroup), and net unless the
 *     unit holds at least one `host:` grant (all-or-nothing: no per-host filtering);
 *   - presents a read-only root filesystem;
 *   - bind-mounts the unit's read / read-write path grants, and only those,
 *     at their real locations (rw grants writable, r grants read-only);
 *   - gives the shell a private /proc, /tmp and an empty /dev;
 *   - drops all capabilities and forbids privilege escalation.
 *
 * Pure argv construction: no process is spawned here, so the mapping from
 * grants to mounts is unit-testable. The smoke-test script runs the argv.
 */

import type { Grant } from "pi-agentic-core";

export interface BwrapOptions {
	/** The unit's grants; path grants become bind mounts, nothing else does. */
	grants: readonly Grant[];
	/** The bash command line to run inside the sandbox. */
	command: string;
	/** Absolute workspace (always bound read-write as the sandbox cwd). */
	workspace: string;
	/** Read-only system roots to expose (default: /usr, /bin, /lib, /lib64, /etc). */
	systemRoots?: readonly string[];
	/** Path to bwrap. Default: /usr/bin/bwrap. */
	bwrapBin?: string;
	/** Path to the shell. Default: /bin/bash. */
	shell?: string;
	/** Non-secret identity exported into the sandbox as ORG_UNIT_ID. */
	unitId?: string;
	/** Non-secret task id exported into the sandbox as ORG_TASK_ID. */
	taskId?: string;
}

const DEFAULT_SYSTEM_ROOTS = ["/usr", "/bin", "/lib", "/lib64", "/etc"] as const;

/**
 * Reduce a path-grant pattern to the concrete directory that must be mounted.
 * The only accepted grammar is a literal path optionally followed by a whole
 * trailing `/*` or `/**` segment. Anything else (`/etc*`, a mid-path `*`, a bare
 * `/*` or `/**`, `/`,
 * relative or non-normalised paths) is refused: rendering fails closed rather
 * than mounting a wider tree than the grant names. The patterns `/d/sales/**` and
 * `/d/sales/*` both mount `/d/sales`; a literal path mounts itself.
 */
export function mountRootOf(pattern: string): string {
	if (!pattern.startsWith("/")) throw new Error(`path grant is not absolute: ${pattern}`);
	const m = /^(.*?)(?:\/\*{1,2})?$/.exec(pattern);
	const base = m?.[1] ?? pattern;
	if (base === "" || base === "/") throw new Error(`path grant would mount the host root: ${pattern}`);
	assertConcretePath(base, `path grant: ${pattern}`);
	return base;
}

/** A concrete mount source: absolute, normalised, no glob/control characters. */
function assertConcretePath(p: string, what: string): void {
	if (!p.startsWith("/") || p === "/") throw new Error(`${what} must be an absolute, non-root path: ${p}`);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
	if (/[*?[\]{}\x00-\x1f\x7f]/.test(p)) throw new Error(`${what} contains glob or control characters: ${JSON.stringify(p)}`);
	const segs = p.slice(1).split("/");
	if (segs.some((x) => x === "" || x === "." || x === "..")) throw new Error(`${what} is not normalised: ${p}`);
}

interface Mount {
	root: string;
	writable: boolean;
}

const depth = (p: string): number => p.split("/").length;

/**
 * Collect the bind mounts implied by a unit's path grants (rw wins over r) plus
 * the always-writable workspace. Mounts are ordered shallow-first so a later,
 * deeper bind is never shadowed by an earlier ancestor bind: an ancestor `r`
 * grant therefore cannot flip the rw workspace beneath it back to read-only.
 */
export function bindMountsForGrants(grants: readonly Grant[], workspace?: string): Mount[] {
	const byRoot = new Map<string, boolean>();
	if (workspace !== undefined) {
		assertConcretePath(workspace, "workspace");
		byRoot.set(workspace, true);
	}
	for (const g of grants) {
		if (g.kind !== "path") continue;
		const root = mountRootOf(g.pattern);
		const writable = g.mode === "rw";
		byRoot.set(root, (byRoot.get(root) ?? false) || writable);
	}
	return [...byRoot.entries()]
		.sort(([a], [b]) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
		.map(([root, writable]) => ({ root, writable }));
}

/**
 * Build the full `bwrap` argv for running `command` under the unit's grants.
 * The returned array is safe to hand to spawn() without a shell.
 */
export function buildBwrapCommand(opts: BwrapOptions): string[] {
	const bwrap = opts.bwrapBin ?? "/usr/bin/bwrap";
	const shell = opts.shell ?? "/bin/bash";
	const systemRoots = opts.systemRoots ?? DEFAULT_SYSTEM_ROOTS;
	assertConcretePath(opts.workspace, "workspace");
	// Validate every grant before emitting anything (fail closed).
	const mounts = bindMountsForGrants(opts.grants, opts.workspace);

	const sandboxEnv: Array<[string, string]> = [
		["PATH", "/usr/local/bin:/usr/bin:/bin"],
		["HOME", opts.workspace],
		["TMPDIR", "/tmp"],
	];
	if (opts.unitId !== undefined) sandboxEnv.push(["ORG_UNIT_ID", opts.unitId]);
	if (opts.taskId !== undefined) sandboxEnv.push(["ORG_TASK_ID", opts.taskId]);
	const envArgs = sandboxEnv.flatMap(([k, v]) => ["--setenv", k, v]);

	const argv: string[] = [
		bwrap,
		"--unshare-all",
		// Network: unshared (no interfaces but loopback) unless the unit holds a host:
		// grant. That is all-or-nothing: which hosts are reachable is NOT enforced here;
		// it needs an egress proxy / firewall outside the sandbox (SPEC FR2).
		...(opts.grants.some((g) => g.kind === "host") ? ["--share-net"] : ["--unshare-net"]),
		"--die-with-parent",
		"--new-session",
		// Start from an empty environment: the parent's secrets (ORG_UNIT_TOKEN,
		// control socket/db paths, API keys) must not reach the shell.
		"--clearenv",
		...envArgs,
		"--cap-drop",
		"ALL",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
	];

	// Read-only system roots (only those that exist are mounted; bwrap skips
	// missing sources only with --ro-bind-try, so use that for optional roots).
	for (const root of systemRoots) {
		argv.push("--ro-bind-try", root, root);
	}

	// Workspace and grant mounts, shallow-first. The workspace is always rw and
	// is part of the same ordered list so ancestor grants cannot shadow it.
	for (const m of mounts) {
		argv.push(m.writable ? "--bind" : "--ro-bind", m.root, m.root);
	}

	// Project-resource dirs are re-bound read-only AFTER every (possibly rw)
	// bind above, so sandboxed bash cannot plant `.pi/extensions` or `.agents`
	// skills that a later session would load (skipped if absent).
	for (const dir of [".pi", ".agents"]) {
		const p = `${opts.workspace}/${dir}`;
		argv.push("--ro-bind-try", p, p);
	}

	argv.push("--chdir", opts.workspace, shell, "-c", opts.command);
	return argv;
}
