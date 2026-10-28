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
	/** True when the token is the operator admin token (human root, ADR-0007). */
	isAdminToken(token: string | undefined): boolean;
}

/** The authenticated principal behind a connection. */
export type Principal =
	| { readonly kind: "unit"; readonly unitId: string }
	| { readonly kind: "admin" };

/** In-memory token + uid registry. The dispatcher populates it as it starts units. */
export class PeerRegistry implements Authenticator {
	private readonly uidToUnit = new Map<number, string>();
	private readonly tokenToUnit = new Map<string, string>();
	private readonly unitToToken = new Map<string, string>();
	private readonly adminTokens = new Set<string>();

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

	/** Issue a fresh operator admin token (human root). Not tied to any unit. */
	issueAdminToken(): string {
		const token = randomBytes(32).toString("hex");
		this.adminTokens.add(token);
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

	isAdminToken(token: string | undefined): boolean {
		if (!token) return false;
		const presented = Buffer.from(token);
		let matched = false;
		for (const known of this.adminTokens) {
			const knownBuf = Buffer.from(known);
			if (knownBuf.length === presented.length && timingSafeEqual(knownBuf, presented)) {
				matched = true;
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
	/**
	 * Unit this connection's socket is bound to (per-unit socket, ADR-0003). The
	 * socket path IS the identity; the OS decides who can connect to it.
	 */
	boundUnit?: string;
	/** Unit id the client claims in `hello` (rejected if it differs from boundUnit). */
	claimedUnit?: string;
}

/**
 * Resolve the authenticated principal for a connection. Prefer the OS-level uid
 * (unforgeable) over the token (bearer secret). A uid always maps to a unit; a
 * token may be the operator admin token (human root) or a unit's dev token.
 * Returns null when nothing matches — the caller must then reject every request.
 */
export function authenticate(auth: Authenticator, cred: PeerCredential): Principal | null {
	if (cred.boundUnit !== undefined) {
		// Per-unit socket: identity = socket. Any conflicting claim (another unit
		// id, the admin token, or another unit's token) is a hard reject.
		if (cred.claimedUnit !== undefined && cred.claimedUnit !== cred.boundUnit) return null;
		if (auth.isAdminToken(cred.token)) return null;
		const tokenUnit = auth.byToken(cred.token);
		if (tokenUnit !== null && tokenUnit !== cred.boundUnit) return null;
		return { kind: "unit", unitId: cred.boundUnit };
	}
	const byUid = auth.byUid(cred.uid);
	if (byUid) return { kind: "unit", unitId: byUid };
	if (auth.isAdminToken(cred.token)) return { kind: "admin" };
	const byToken = auth.byToken(cred.token);
	if (byToken) return { kind: "unit", unitId: byToken };
	return null;
}

/** Prefix of the dedicated Unix user/group of a unit worker (`pi-u-<id>`). */
export const UNIT_USER_PREFIX = "pi-u-";
