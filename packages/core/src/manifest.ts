/**
 * Unit manifest (`unit.json`). JSON, not YAML, to keep zero runtime deps (ADR-0001).
 * Validation is fail-closed (SPEC FR1).
 */
import { type Grant, parseGrant } from "./grants.ts";

export interface Budget {
	tokens: number;
	costUsd: number;
	wallClockSec: number;
}

export interface Manifest {
	id: string;
	/** Org path, e.g. "sales/emea". Root unit has path equal to id. */
	path: string;
	parent: string | null;
	owner: string;
	grants: Grant[];
	budget: Budget;
	limits: { maxDepth: number; maxChildren: number; maxAttempts: number };
	expiresAt: string | null;
	minEval: number | null;
}

export class ManifestError extends Error {
	readonly problems: string[];
	constructor(problems: string[]) {
		super(`invalid manifest: ${problems.join("; ")}`);
		this.problems = problems;
	}
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PATH = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonNegNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

export function parseManifest(input: unknown): Manifest {
	const p: string[] = [];
	if (!isObj(input)) throw new ManifestError(["manifest must be an object"]);
	const known = new Set(["id", "path", "parent", "owner", "grants", "budget", "limits", "expiresAt", "minEval"]);
	for (const k of Object.keys(input)) if (!known.has(k)) p.push(`unknown field '${k}'`);

	const { id, path, parent, owner, grants, budget, limits, expiresAt, minEval } = input;
	if (typeof id !== "string" || !ID.test(id)) p.push("id must match [a-z0-9][a-z0-9-]*");
	if (typeof path !== "string" || !PATH.test(path)) p.push("path must be a/b/c of lowercase segments");
	if (parent !== null && (typeof parent !== "string" || !ID.test(parent))) p.push("parent must be a unit id or null");
	if (typeof owner !== "string" || owner.length === 0) p.push("owner is required");

	const parsedGrants: Grant[] = [];
	if (!Array.isArray(grants)) p.push("grants must be an array");
	else
		for (const g of grants) {
			if (typeof g !== "string") {
				p.push("grant must be a string");
				continue;
			}
			try {
				parsedGrants.push(parseGrant(g));
			} catch (e) {
				p.push((e as Error).message);
			}
		}

	if (!isObj(budget) || !isNonNegNum(budget.tokens) || !isNonNegNum(budget.costUsd) || !isNonNegNum(budget.wallClockSec)) {
		p.push("budget needs non-negative tokens, costUsd, wallClockSec");
	}
	const lim = limits === undefined ? {} : limits;
	if (!isObj(lim)) p.push("limits must be an object");
	const L = isObj(lim) ? lim : {};
	const maxDepth = L.maxDepth ?? 4;
	const maxChildren = L.maxChildren ?? 8;
	const maxAttempts = L.maxAttempts ?? 2;
	if (!isPosInt(maxDepth) || !isPosInt(maxChildren) || !isPosInt(maxAttempts)) p.push("limits must be positive integers");

	const exp = expiresAt ?? null;
	if (exp !== null && (typeof exp !== "string" || Number.isNaN(Date.parse(exp)))) p.push("expiresAt must be ISO date or null");
	const me = minEval ?? null;
	if (me !== null && (typeof me !== "number" || me < 0 || me > 1)) p.push("minEval must be in [0,1] or null");

	if (p.length > 0) throw new ManifestError(p);
	const b = budget as Obj;
	return {
		id: id as string,
		path: path as string,
		parent: parent as string | null,
		owner: owner as string,
		grants: parsedGrants,
		budget: { tokens: b.tokens as number, costUsd: b.costUsd as number, wallClockSec: b.wallClockSec as number },
		limits: { maxDepth: maxDepth as number, maxChildren: maxChildren as number, maxAttempts: maxAttempts as number },
		expiresAt: exp as string | null,
		minEval: me as number | null,
	};
}
