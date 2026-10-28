/**
 * Grants: the unit of authority. Grammar (v0.1):
 *   tool:<name>                 e.g. tool:read, tool:bash, tool:* (all non-shell tools;
 *                               bash/powershell need an exact grant)
 *   path:<r|rw>:<absolute glob> e.g. path:rw:/var/lib/org/units/sales/workspace/**
 *   delegate:<unit-path>        e.g. delegate:sales, delegate:sales/* (descendants)
 *   mcp:<server>                e.g. mcp:crm
 *   host:<hostname>             e.g. host:api.example.com
 *
 * Authority only narrows (ADR-0005): child ⊆ parent.
 */
import { posix } from "node:path";

export type Grant =
	| { kind: "tool"; name: string }
	| { kind: "path"; mode: "r" | "rw"; pattern: string }
	| { kind: "delegate"; target: string }
	| { kind: "mcp"; server: string }
	| { kind: "host"; host: string };

export class GrantParseError extends Error {}

const NAME = /^[A-Za-z0-9_.*-]+$/;
const UNIT_PATH = /^(\*|[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*(\/\*)?)$/;

export function parseGrant(raw: string): Grant {
	const idx = raw.indexOf(":");
	if (idx <= 0) throw new GrantParseError(`grant missing kind: ${raw}`);
	const kind = raw.slice(0, idx);
	const rest = raw.slice(idx + 1);
	switch (kind) {
		case "tool":
		case "mcp":
		case "host": {
			if (!NAME.test(rest)) throw new GrantParseError(`invalid ${kind} grant: ${raw}`);
			if (kind === "tool") return { kind, name: rest };
			if (kind === "mcp") return { kind, server: rest };
			return { kind, host: rest.toLowerCase() };
		}
		case "path": {
			const m = /^(r|rw):(\/.*)$/.exec(rest);
			if (!m) throw new GrantParseError(`invalid path grant (need path:r|rw:/abs): ${raw}`);
			const [, mode, path] = m;
			if (path === undefined) throw new GrantParseError(`invalid path grant: ${raw}`);
			return { kind, mode: mode === "rw" ? "rw" : "r", pattern: normalizePattern(path) };
		}
		case "delegate": {
			if (!UNIT_PATH.test(rest)) throw new GrantParseError(`invalid delegate grant: ${raw}`);
			return { kind, target: rest };
		}
		default:
			throw new GrantParseError(`unknown grant kind: ${kind}`);
	}
}

export function formatGrant(g: Grant): string {
	switch (g.kind) {
		case "tool":
			return `tool:${g.name}`;
		case "path":
			return `path:${g.mode}:${g.pattern}`;
		case "delegate":
			return `delegate:${g.target}`;
		case "mcp":
			return `mcp:${g.server}`;
		case "host":
			return `host:${g.host}`;
	}
}

export function parseGrants(raw: readonly string[]): Grant[] {
	return raw.map(parseGrant);
}

/**
 * Normalize a path pattern and enforce the small, safe grammar:
 *   /a/b      exactly /a/b
 *   /a/b/*    direct children of /a/b
 *   /a/b/**   /a/b and everything under it
 * A `*` may only appear as a whole final segment (`/*` or `/**`), there must be
 * at least one real segment before it, and `..` is rejected so patterns cannot
 * climb. This refuses root-level wildcards (`/`, `/*`, `/**`) and mid-segment
 * globs (`/etc*`) that would otherwise mount far more than intended.
 */
const PATH_PATTERN = /^(\/[^/*]+)+(\/\*\*?)?$/;
function normalizePattern(p: string): string {
	if (p.split("/").includes("..")) throw new GrantParseError(`path grant may not contain '..': ${p}`);
	const n = posix.normalize(p);
	const trimmed = n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
	if (!PATH_PATTERN.test(trimmed)) {
		throw new GrantParseError(`path grant too broad or malformed (need /a/b, /a/b/* or /a/b/**): ${p}`);
	}
	return trimmed;
}

/**
 * Path pattern semantics (deliberately small):
 *   /a/b      exactly /a/b
 *   /a/b/*    direct children of /a/b
 *   /a/b/**   /a/b and everything under it
 */
export function pathMatches(pattern: string, absPath: string): boolean {
	const p = posix.normalize(absPath);
	if (pattern.endsWith("/**")) {
		const base = pattern.slice(0, -3) || "/";
		return p === base || p.startsWith(base === "/" ? "/" : `${base}/`);
	}
	if (pattern.endsWith("/*")) {
		const base = pattern.slice(0, -2) || "/";
		return posix.dirname(p) === base && p !== base;
	}
	return p === pattern;
}

/**
 * Map the literal prefix of every path grant (the part before a trailing `/*` or
 * `/**`) through `realpath`, so grants compare against already-realpathed request
 * paths. The canonical grant REPLACES the original: a symlinked literal prefix
 * must not keep matching, because request paths are always realpathed and a
 * non-canonical grant could only ever widen scope. Non-path grants pass through.
 * A resolver throw propagates (callers fail closed), and a canonical prefix that
 * is not a valid grant root (e.g. a link to `/`) throws rather than widening.
 */
export function canonicalizePathGrants(grants: readonly Grant[], realpath: (p: string) => string): Grant[] {
	return grants.map((g) => {
		if (g.kind !== "path") return g;
		const m = /^(.*?)(\/\*\*?)?$/.exec(g.pattern);
		const suffix = m?.[2] ?? "";
		const prefix = m?.[1] ?? g.pattern;
		const canon = realpath(prefix);
		if (canon === prefix) return g;
		const pattern = normalizePattern(canon + suffix);
		return { kind: "path", mode: g.mode, pattern };
	});
}

/** Is pattern `child` covered entirely by pattern `parent`? */
export function patternWithin(child: string, parent: string): boolean {
	if (child === parent) return true;
	if (parent.endsWith("/**")) {
		// child `/x`, `/x/*` or `/x/**` is covered iff /x is the parent base or under it
		const childBase = child.replace(/\/\*\*?$/, "") || "/";
		if (childBase.includes("*")) return false;
		return pathMatches(parent, childBase);
	}
	if (parent.endsWith("/*")) {
		// only exact direct-child paths fit inside a single-level wildcard
		return !child.includes("*") && pathMatches(parent, child);
	}
	return false;
}

/** Unit-path match for delegate grants. `sales/*` covers descendants of sales, not sales itself. */
export function unitMatches(target: string, unitPath: string): boolean {
	if (target === "*") return true;
	if (target.endsWith("/*")) return unitPath.startsWith(`${target.slice(0, -2)}/`);
	return target === unitPath;
}

function delegateWithin(child: string, parent: string): boolean {
	if (parent === "*") return true;
	if (child === "*") return false;
	if (parent.endsWith("/*")) {
		const base = parent.slice(0, -2);
		const c = child.endsWith("/*") ? child.slice(0, -2) : child;
		return c.startsWith(`${base}/`);
	}
	return child === parent;
}

/** Tools that execute arbitrary commands. Only an exact grant covers them; `tool:*` never does. */
export const SHELL_TOOLS: readonly string[] = ["bash", "powershell"];

function nameWithin(child: string, parent: string): boolean {
	return parent === "*" || child === parent;
}

function toolWithin(child: string, parent: string): boolean {
	if (SHELL_TOOLS.includes(child)) return child === parent;
	return nameWithin(child, parent);
}

/** Is a single grant covered by at least one grant in `parent`? */
export function grantCovered(g: Grant, parent: readonly Grant[]): boolean {
	return parent.some((p) => {
		if (p.kind !== g.kind) return false;
		switch (g.kind) {
			case "tool":
				return toolWithin(g.name, (p as typeof g).name);
			case "mcp":
				return nameWithin(g.server, (p as typeof g).server);
			case "host":
				return nameWithin(g.host, (p as typeof g).host);
			case "delegate":
				return delegateWithin(g.target, (p as typeof g).target);
			case "path": {
				const pp = p as typeof g;
				if (g.mode === "rw" && pp.mode !== "rw") return false;
				return patternWithin(g.pattern, pp.pattern);
			}
		}
	});
}

/** child ⊆ parent. Returns the uncovered grants (empty = subset). */
export function uncovered(child: readonly Grant[], parent: readonly Grant[]): Grant[] {
	return child.filter((g) => !grantCovered(g, parent));
}

/**
 * Effective grants for a task = unit ∩ task. For each task grant: kept as-is if the unit covers it;
 * otherwise narrowed to the unit grants that the task grant covers (e.g. task `path:rw:/a/**` vs unit
 * `path:r:/a/b` yields `path:r:/a/b`). Grants with no overlap are dropped (fail closed).
 * If no task grants are given, the unit grants apply.
 */
export function effectiveGrants(unit: readonly Grant[], task: readonly Grant[] | undefined): Grant[] {
	if (task === undefined) return [...unit];
	const out: Grant[] = [];
	const seen = new Set<string>();
	const add = (g: Grant): void => {
		const k = formatGrant(g);
		if (seen.has(k)) return;
		seen.add(k);
		out.push(g);
	};
	for (const g of task) {
		if (grantCovered(g, unit)) add(g);
		else for (const u of unit) if (grantCovered(u, [g])) add(u);
	}
	return out;
}
