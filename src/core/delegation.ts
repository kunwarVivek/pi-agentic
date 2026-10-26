/**
 * Delegation validation (SPEC FR3). Pure: caller supplies org snapshot.
 */
import { fits, remaining } from "./budget.ts";
import { type Grant, formatGrant, uncovered, unitMatches } from "./grants.ts";
import type { Budget, Manifest } from "./manifest.ts";

export interface DelegationRequest {
	fromUnit: string;
	toUnit: string;
	/** Task the caller is currently executing (null = root/own initiative). */
	parentTaskId: string | null;
	grants: Grant[] | undefined;
	budget: Budget;
}

export interface OrgSnapshot {
	units: ReadonlyMap<string, Manifest & { status: UnitStatus }>;
	/** Effective grants of the caller in the context of parentTaskId. */
	callerGrants: readonly Grant[];
	/** Caller's budget usage so far and amount already reserved for open children. */
	callerUsed: Budget;
	callerReserved: Budget;
	/** Units along the parent_task chain, root first, ending with fromUnit. */
	taskChainUnits: readonly string[];
	/** Number of open child tasks already created under parentTaskId. */
	openChildren: number;
}

export type UnitStatus = "active" | "suspended" | "deprecated" | "retired";

export type DelegationCheck = { ok: true } | { ok: false; code: string; reason: string };

export function isDescendant(units: OrgSnapshot["units"], ancestor: string, unit: string): boolean {
	let cur = units.get(unit)?.parent ?? null;
	const seen = new Set<string>();
	while (cur !== null && !seen.has(cur)) {
		if (cur === ancestor) return true;
		seen.add(cur);
		cur = units.get(cur)?.parent ?? null;
	}
	return false;
}

export function checkDelegation(req: DelegationRequest, org: OrgSnapshot): DelegationCheck {
	const from = org.units.get(req.fromUnit);
	const to = org.units.get(req.toUnit);
	if (!from) return { ok: false, code: "unknown_from", reason: `unknown unit ${req.fromUnit}` };
	if (!to) return { ok: false, code: "unknown_to", reason: `unknown unit ${req.toUnit}` };
	if (from.status !== "active") return { ok: false, code: "from_inactive", reason: `${from.id} is ${from.status}` };
	if (to.status !== "active") return { ok: false, code: "to_inactive", reason: `${to.id} is ${to.status}` };
	if (req.fromUnit === req.toUnit) return { ok: false, code: "self", reason: "cannot delegate to self" };

	const delegateGranted = org.callerGrants.some((g) => g.kind === "delegate" && unitMatches(g.target, to.path));
	if (!delegateGranted) {
		return { ok: false, code: "not_authorized", reason: `${from.id} has no delegate grant covering ${to.path}` };
	}
	const isDesc = isDescendant(org.units, from.id, to.id);
	if (!isDesc && !org.callerGrants.some((g) => g.kind === "delegate" && g.target !== "*" && unitMatches(g.target, to.path))) {
		// lateral delegation requires an explicit (non-wildcard) grant
		return { ok: false, code: "lateral_needs_explicit", reason: `${to.path} is not a descendant; explicit delegate grant required` };
	}

	if (req.grants) {
		const extra = uncovered(req.grants, org.callerGrants);
		if (extra.length) {
			return { ok: false, code: "widening", reason: `grants exceed caller authority: ${extra.map(formatGrant).join(", ")}` };
		}
	}

	const rem = remaining(from.budget, org.callerUsed, org.callerReserved);
	if (!fits(req.budget, rem)) return { ok: false, code: "budget", reason: "requested budget exceeds caller's remaining budget" };
	if (!fits(req.budget, to.budget)) {
		return { ok: false, code: "budget_target", reason: "requested budget exceeds target unit's budget ceiling" };
	}

	const depth = org.taskChainUnits.length; // new task depth = chain length + 1 (root task depth 1)
	if (depth + 1 > from.limits.maxDepth) return { ok: false, code: "depth", reason: `max depth ${from.limits.maxDepth} reached` };
	if (org.openChildren + 1 > from.limits.maxChildren) {
		return { ok: false, code: "fanout", reason: `max children ${from.limits.maxChildren} reached` };
	}
	if (org.taskChainUnits.includes(req.toUnit)) {
		return { ok: false, code: "cycle", reason: `${req.toUnit} already in task chain` };
	}
	return { ok: true };
}
