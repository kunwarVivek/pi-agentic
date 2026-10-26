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
