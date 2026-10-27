/**
 * bubblewrap bash sandbox (SPEC S6 / ADR-0002).
 *
 * `bash` is denied unless a unit holds the `tool:bash` grant, and a unit with
 * that grant must run its shell under an OS boundary. On Linux that boundary is
 * bubblewrap (`bwrap`): an unprivileged user-namespace sandbox. This module
 * turns a unit's path grants into a `bwrap` argv that:
 *   - unshares every namespace it can (user, pid, ipc, uts, cgroup, net);
 *   - presents a read-only root filesystem;
 *   - bind-mounts the unit's read / read-write path grants, and only those,
 *     at their real locations (rw grants writable, r grants read-only);
 *   - gives the shell a private /proc, /tmp and an empty /dev;
 *   - drops all capabilities and forbids privilege escalation.
 *
 * Pure argv construction: no process is spawned here, so the mapping from
 * grants to mounts is unit-testable. The smoke-test script runs the argv.
 */

import type { Grant } from "@agentic-pi/core";

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
}

const DEFAULT_SYSTEM_ROOTS = ["/usr", "/bin", "/lib", "/lib64", "/etc"] as const;

/**
 * Reduce a path-grant pattern to the concrete directory that must be mounted.
 * Grant patterns are one of `/a/b`, `/a/b/*`, `/a/b/**` (see core/grants.ts), so
 * any glob is always preceded by a path separator: strip from the first `*` and
 * drop the trailing slash. `/d/sales/**` and `/d/sales/*` both mount `/d/sales`;
 * a literal path mounts itself.
 */
export function mountRootOf(pattern: string): string {
	if (!pattern.startsWith("/")) throw new Error(`path grant is not absolute: ${pattern}`);
	const star = pattern.indexOf("*");
	const base = star === -1 ? pattern : pattern.slice(0, star);
	const trimmed = base.replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}

interface Mount {
	root: string;
	writable: boolean;
}

/** Collect the bind mounts implied by a unit's path grants (rw wins over r). */
export function bindMountsForGrants(grants: readonly Grant[]): Mount[] {
	const byRoot = new Map<string, boolean>();
	for (const g of grants) {
		if (g.kind !== "path") continue;
		const root = mountRootOf(g.pattern);
		const writable = g.mode === "rw";
		byRoot.set(root, (byRoot.get(root) ?? false) || writable);
	}
	return [...byRoot.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([root, writable]) => ({ root, writable }));
}

/**
 * Build the full `bwrap` argv for running `command` under the unit's grants.
 * The returned array is safe to hand to spawn() without a shell.
 */
export function buildBwrapCommand(opts: BwrapOptions): string[] {
	const bwrap = opts.bwrapBin ?? "/usr/bin/bwrap";
	const shell = opts.shell ?? "/bin/bash";
	const systemRoots = opts.systemRoots ?? DEFAULT_SYSTEM_ROOTS;
	if (!opts.workspace.startsWith("/")) throw new Error(`workspace must be absolute: ${opts.workspace}`);

	const argv: string[] = [
		bwrap,
		"--unshare-all",
		"--die-with-parent",
		"--new-session",
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

	// The workspace is always writable and becomes the cwd.
	argv.push("--bind", opts.workspace, opts.workspace);

	// Grant-derived mounts. A writable mount uses --bind; read-only uses --ro-bind.
	for (const m of bindMountsForGrants(opts.grants)) {
		if (m.root === opts.workspace) continue; // already bound rw above
		argv.push(m.writable ? "--bind" : "--ro-bind", m.root, m.root);
	}

	argv.push("--chdir", opts.workspace, shell, "-c", opts.command);
	return argv;
}
