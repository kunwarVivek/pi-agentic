/**
 * Peer authentication for the control plane (ADR-0003).
 *
 * Production (Linux): the server reads the connecting peer's uid via
 * SO_PEERCRED and maps it to a unit id. node:net does not expose SO_PEERCRED,
 * so that mapping is supplied by the dispatcher (which knows which OS user runs
 * which unit) through a uid→unit table. This module stays pure and testable;
 * the socket layer passes in whatever credential it observed.
 *
 * Development (macOS): there is no peer-cred check, so each unit gets a random
 * token written to a mode-600 file. The worker sends the token in `hello`; the
 * server matches it to the unit. Tokens are compared in constant time.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

export interface Authenticator {
	/** Resolve a unit id from an observed uid, or null if unknown. */
	byUid(uid: number | undefined): string | null;
	/** Resolve a unit id from a presented token, or null if unknown. */
	byToken(token: string | undefined): string | null;
}

/** In-memory token + uid registry. The dispatcher populates it as it starts units. */
export class PeerRegistry implements Authenticator {
	private readonly uidToUnit = new Map<number, string>();
	private readonly tokenToUnit = new Map<string, string>();
	private readonly unitToToken = new Map<string, string>();

	bindUid(uid: number, unitId: string): void {
		this.uidToUnit.set(uid, unitId);
	}

	/** Issue (or return the existing) dev token for a unit. */
	issueToken(unitId: string): string {
		const existing = this.unitToToken.get(unitId);
		if (existing) return existing;
		const token = randomBytes(32).toString("hex");
		this.unitToToken.set(unitId, token);
		this.tokenToUnit.set(token, unitId);
		return token;
	}

	byUid(uid: number | undefined): string | null {
		if (uid === undefined) return null;
		return this.uidToUnit.get(uid) ?? null;
	}

	byToken(token: string | undefined): string | null {
		if (!token) return null;
		// Constant-time compare against every known token to avoid leaking which
		// prefix matched. The set is small (one per unit).
		let matched: string | null = null;
		const presented = Buffer.from(token);
		for (const [known, unit] of this.tokenToUnit) {
			const knownBuf = Buffer.from(known);
			if (knownBuf.length === presented.length && timingSafeEqual(knownBuf, presented)) {
				matched = unit;
			}
		}
		return matched;
	}
}

export interface PeerCredential {
	/** Observed peer uid, when the platform provides it (Linux). */
	uid?: number;
	/** Token presented by the worker in `hello` (dev). */
	token?: string;
}

/**
 * Resolve the authenticated unit for a connection. Prefer the OS-level uid
 * (unforgeable) over the token (bearer secret). Returns null when neither
 * credential maps to a unit — the caller must then reject every request.
 */
export function authenticate(auth: Authenticator, cred: PeerCredential): string | null {
	return auth.byUid(cred.uid) ?? auth.byToken(cred.token);
}
