/**
 * Tamper-evident audit chain (SPEC FR7).
 * hash_n = sha256(hash_{n-1} || canonicalJson(entry_n)); genesis prev = 64 zeros.
 */
import { createHash } from "node:crypto";

export const GENESIS = "0".repeat(64);

export interface AuditEntry {
	seq: number;
	at: string;
	actor: string;
	action: string;
	subject: string;
	data: unknown;
}

export interface ChainedEntry extends AuditEntry {
	prevHash: string;
	hash: string;
}

/** Deterministic JSON: sorted object keys, no whitespace. Rejects non-finite numbers. */
export function canonicalJson(v: unknown): string {
	if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
	if (typeof v === "number") {
		if (!Number.isFinite(v)) throw new TypeError("non-finite number in canonical JSON");
		return JSON.stringify(v);
	}
	if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
	if (typeof v === "object") {
		const o = v as Record<string, unknown>;
		const keys = Object.keys(o)
			.filter((k) => o[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
	}
	throw new TypeError(`unsupported type in canonical JSON: ${typeof v}`);
}

export function hashEntry(prevHash: string, e: AuditEntry): string {
	return createHash("sha256").update(prevHash).update(canonicalJson(e)).digest("hex");
}

export function chain(prev: ChainedEntry | null, e: Omit<AuditEntry, "seq">): ChainedEntry {
	const entry: AuditEntry = { ...e, seq: prev ? prev.seq + 1 : 1 };
	const prevHash = prev ? prev.hash : GENESIS;
	return { ...entry, prevHash, hash: hashEntry(prevHash, entry) };
}

export type VerifyResult = { ok: true; count: number } | { ok: false; badSeq: number; reason: string };

export function verify(entries: readonly ChainedEntry[]): VerifyResult {
	let prevHash = GENESIS;
	let expectSeq = 1;
	for (const c of entries) {
		const { prevHash: ph, hash, ...entry } = c;
		if (entry.seq !== expectSeq) return { ok: false, badSeq: entry.seq, reason: `expected seq ${expectSeq}` };
		if (ph !== prevHash) return { ok: false, badSeq: entry.seq, reason: "prevHash mismatch" };
		if (hashEntry(prevHash, entry) !== hash) return { ok: false, badSeq: entry.seq, reason: "hash mismatch" };
		prevHash = hash;
		expectSeq++;
	}
	return { ok: true, count: entries.length };
}

/**
 * An audit anchor (SPEC G6 / threats): a small off-host snapshot of the chain
 * head. Exporting it periodically makes a full-chain rewrite detectable — an
 * attacker who rebuilds history locally cannot match an anchor already written
 * elsewhere. The anchor is itself integrity-checked with its own hash so a
 * tampered anchor file is rejected too.
 */
export interface AuditAnchor {
	/** Number of entries covered (the head's seq). */
	count: number;
	/** Head entry seq (0 when the chain is empty). */
	headSeq: number;
	/** Head entry hash (GENESIS when the chain is empty). */
	headHash: string;
	/** ISO timestamp the anchor was produced. */
	at: string;
	/** Integrity hash over the anchor's own fields. */
	anchorHash: string;
}

function anchorPayload(count: number, headSeq: number, headHash: string, at: string): string {
	return canonicalJson({ count, headSeq, headHash, at });
}

/** Produce an anchor for the current chain head. `at` is injected for determinism. */
export function buildAnchor(entries: readonly ChainedEntry[], at: string): AuditAnchor {
	const head = entries.at(-1);
	const headSeq = head ? head.seq : 0;
	const headHash = head ? head.hash : GENESIS;
	const count = entries.length;
	const anchorHash = createHash("sha256").update(anchorPayload(count, headSeq, headHash, at)).digest("hex");
	return { count, headSeq, headHash, at, anchorHash };
}

/** True when the anchor's own integrity hash matches its fields. */
export function anchorIsIntact(a: AuditAnchor): boolean {
	const expected = createHash("sha256").update(anchorPayload(a.count, a.headSeq, a.headHash, a.at)).digest("hex");
	return timingSafeHexEqual(expected, a.anchorHash);
}

export type AnchorCheck =
	| { ok: true; count: number }
	| { ok: false; reason: "anchor_corrupt" | "truncated" | "head_mismatch" | "chain_invalid"; detail: string };

/**
 * Verify a chain is a faithful continuation of a previously-exported anchor:
 *   - the anchor file itself is intact,
 *   - the chain still has at least `anchor.count` entries (no truncation),
 *   - the entry at `anchor.headSeq` still hashes to `anchor.headHash` (history
 *     up to the anchor was not rewritten),
 *   - and the whole chain verifies.
 */
export function verifyAgainstAnchor(entries: readonly ChainedEntry[], anchor: AuditAnchor): AnchorCheck {
	if (!anchorIsIntact(anchor)) return { ok: false, reason: "anchor_corrupt", detail: "anchor integrity hash mismatch" };
	const v = verify(entries);
	if (!v.ok) return { ok: false, reason: "chain_invalid", detail: `bad seq ${v.badSeq}: ${v.reason}` };
	if (entries.length < anchor.count) {
		return { ok: false, reason: "truncated", detail: `chain has ${entries.length} entries, anchor covers ${anchor.count}` };
	}
	if (anchor.headSeq > 0) {
		// Entries are seq-ordered from 1, so the anchored head sits at index headSeq-1.
		const at = entries[anchor.headSeq - 1];
		if (!at || at.seq !== anchor.headSeq || !timingSafeHexEqual(at.hash, anchor.headHash)) {
			return { ok: false, reason: "head_mismatch", detail: `entry at seq ${anchor.headSeq} does not match the anchor` };
		}
	}
	return { ok: true, count: entries.length };
}

/** Constant-time compare for equal-length hex digests (avoids early-exit leaks). */
function timingSafeHexEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
