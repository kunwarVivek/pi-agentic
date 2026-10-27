/** Budget arithmetic (SPEC FR6). Pure. */
import type { Budget } from "./manifest.ts";

export const ZERO: Budget = { tokens: 0, costUsd: 0, wallClockSec: 0 };

const KEYS = ["tokens", "costUsd", "wallClockSec"] as const;

export function add(a: Budget, b: Budget): Budget {
	return { tokens: a.tokens + b.tokens, costUsd: a.costUsd + b.costUsd, wallClockSec: a.wallClockSec + b.wallClockSec };
}

export function sub(a: Budget, b: Budget): Budget {
	return { tokens: a.tokens - b.tokens, costUsd: a.costUsd - b.costUsd, wallClockSec: a.wallClockSec - b.wallClockSec };
}

/** a ≤ b on every dimension. */
export function fits(a: Budget, b: Budget): boolean {
	return KEYS.every((k) => a[k] <= b[k]);
}

/** Dimensions where `used` has reached or exceeded `limit`. */
export function exhausted(used: Budget, limit: Budget): Array<keyof Budget> {
	return KEYS.filter((k) => used[k] >= limit[k]);
}

/** Remaining = limit − used − reservedForChildren, floored at zero. */
export function remaining(limit: Budget, used: Budget, reserved: Budget): Budget {
	const r = sub(sub(limit, used), reserved);
	return { tokens: Math.max(0, r.tokens), costUsd: Math.max(0, r.costUsd), wallClockSec: Math.max(0, r.wallClockSec) };
}
