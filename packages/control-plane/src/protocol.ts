/**
 * Control-plane RPC protocol (ADR-0003). Transport is a Unix-domain socket
 * carrying newline-delimited JSON ("JSON lines"): one request object per line,
 * one response object per line. Zero runtime deps (ADR-0001) — framing is a
 * split on "\n".
 *
 * The caller's unit identity is NEVER taken from the request body; the server
 * derives it from the authenticated peer (SO_PEERCRED uid on Linux, token file
 * in dev). A request that names a `fromUnit` other than the authenticated unit
 * is rejected (anti-forgery, SPEC threat model).
 */

import type { Budget } from "pi-agentic-core";
import type { Contract } from "pi-agentic-core";

export const PROTOCOL_VERSION = 1;

/** Methods the worker may invoke. Reads are snapshot-oriented; the rest mutate. */
export type RpcMethod =
	| "hello"
	| "snapshot"
	| "delegate"
	| "complete_task"
	| "escalate"
	| "meter"
	| "record_decision"
	| "list_approvals"
	| "resolve_approval"
	| "ack_notification"
	| "list_notifications"
	| "ack_owner_notification"
	/** Admin-only: reconcile units with authored unit.json manifests (additive, audited). */
	| "sync_units";

export interface RpcRequest {
	/** Correlation id chosen by the client; echoed in the response. */
	id: number;
	method: RpcMethod;
	params: Record<string, unknown>;
}

export interface RpcOk {
	id: number;
	ok: true;
	result: unknown;
}

export interface RpcErr {
	id: number;
	ok: false;
	error: { code: RpcErrorCode; message: string };
}

export type RpcResponse = RpcOk | RpcErr;

export type RpcErrorCode =
	| "unauthenticated"
	| "forbidden"
	| "bad_request"
	| "not_found"
	| "internal"
	| "version_mismatch";

/** Params for each mutating method (validated server-side before use). */
export interface DelegateParams {
	toUnit: string;
	goal: string;
	contract: Contract;
	grants?: string[];
	budget: Budget;
	deadline?: string | null;
	parentTask?: string | null;
}

export interface CompleteParams {
	taskId: string;
	artifact: unknown;
}

export interface EscalateParams {
	taskId: string;
	question: string;
	options: string[];
}

export interface MeterParams {
	taskId: string;
	usage: Budget;
}

export interface ResolveApprovalParams {
	id: string;
	decision: "approved" | "denied";
	choice?: string;
}

// ---- framing -------------------------------------------------------------

/** Encode one message as a single JSON line (newline-terminated). */
export function encodeLine(msg: RpcRequest | RpcResponse): string {
	return `${JSON.stringify(msg)}\n`;
}

/**
 * Incremental newline-delimited JSON decoder. Feed it chunks; it yields parsed
 * objects for each complete line and retains any partial trailing line.
 */
export class LineDecoder {
	private buffer = "";
	private readonly max: number;

	/** @param maxLineBytes guard against unbounded buffering (default 1 MiB). */
	constructor(maxLineBytes = 1024 * 1024) {
		this.max = maxLineBytes;
	}

	push(chunk: string): unknown[] {
		this.buffer += chunk;
		// Measure UTF-8 bytes, not UTF-16 code units, so the cap is a true byte budget.
		if (Buffer.byteLength(this.buffer, "utf8") > this.max) {
			this.buffer = "";
			throw new Error("rpc line exceeded maximum length");
		}
		const out: unknown[] = [];
		let nl = this.buffer.indexOf("\n");
		while (nl !== -1) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (line.trim().length > 0) {
				try {
					out.push(JSON.parse(line));
				} catch {
					throw new Error("rpc line was not valid JSON");
				}
			}
			nl = this.buffer.indexOf("\n");
		}
		return out;
	}
}
