/**
 * ControlServer: the only writer of control.db, exposed over a Unix-domain
 * socket as newline-delimited JSON (ADR-0003). It authenticates the connecting
 * peer, derives the caller's unit id from the credential (never from the
 * request body), validates params, and dispatches to a ControlStore.
 *
 * The socket layer is thin: a `handleRequest` method does all the policy work
 * and is unit-testable without a real socket. `listen` wires it to node:net.
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, rmSync } from "node:fs";

import type { Budget } from "@agentic-pi/core";
import { parseGrants } from "@agentic-pi/core";
import type { Contract } from "@agentic-pi/core";
import type { ControlStore } from "./store-control.ts";
import {
	type Authenticator,
	type PeerCredential,
	authenticate,
} from "./auth.ts";
import {
	LineDecoder,
	PROTOCOL_VERSION,
	type RpcRequest,
	type RpcResponse,
	encodeLine,
} from "./protocol.ts";
import type { WorkerSnapshot } from "./control-client.ts";

export interface ControlServerOptions {
	store: ControlStore;
	auth: Authenticator;
	/** Resolve a connection's credential. Socket layer supplies uid/token. */
}

/** A single authenticated session's identity. */
interface Session {
	unitId: string;
}

function ok(id: number, result: unknown): RpcResponse {
	return { id, ok: true, result };
}

import type { RpcErrorCode } from "./protocol.ts";
function makeErr(code: RpcErrorCode, id: number, message: string): RpcResponse {
	return { id, ok: false, error: { code, message } };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asBudget = (v: unknown): Budget => {
	const o = isObj(v) ? v : {};
	const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
	return { tokens: n(o.tokens), costUsd: n(o.costUsd), wallClockSec: n(o.wallClockSec) };
};

export class ControlServer {
	private readonly store: ControlStore;
	private readonly auth: Authenticator;
	private server: Server | null = null;
	private socketPath: string | null = null;

	constructor(opts: ControlServerOptions) {
		this.store = opts.store;
		this.auth = opts.auth;
	}

	/** Build the read snapshot a worker needs to run the PDP locally. */
	snapshotFor(unitId: string, taskId: string | null): WorkerSnapshot {
		const unit = this.store.getUnit(unitId);
		const task = taskId ? this.store.getTask(taskId) : null;
		const remainingBudget = unit ? this.store.remainingBudget(unitId) : { tokens: 0, costUsd: 0, wallClockSec: 0 };
		return { unit, task, remainingBudget };
	}

	/**
	 * Handle one decoded request for an authenticated session. Pure w.r.t. the
	 * socket: returns the response object to serialize. `taskId` is the worker's
	 * current task, presented at `hello` and pinned to the session.
	 */
	async handleRequest(req: RpcRequest, session: Session, taskId: string | null): Promise<RpcResponse> {
		const p = req.params ?? {};
		switch (req.method) {
			case "hello": {
				const version = typeof p.version === "number" ? p.version : 0;
				if (version !== PROTOCOL_VERSION) {
					return makeErr("version_mismatch", req.id, `server speaks protocol ${PROTOCOL_VERSION}`);
				}
				return ok(req.id, { unitId: session.unitId, snapshot: this.snapshotFor(session.unitId, taskId) });
			}
			case "snapshot":
				return ok(req.id, this.snapshotFor(session.unitId, taskId));
			case "delegate": {
				if (typeof p.toUnit !== "string" || typeof p.goal !== "string" || !isObj(p.contract)) {
					return makeErr("bad_request", req.id, "delegate needs toUnit, goal, contract");
				}
				let grants;
				try {
					grants = Array.isArray(p.grants) ? parseGrants(p.grants as string[]) : undefined;
				} catch (e) {
					return makeErr("bad_request", req.id, `invalid grants: ${(e as Error).message}`);
				}
				const result = this.store.delegate({
					fromUnit: session.unitId,
					toUnit: p.toUnit,
					goal: p.goal,
					// SAFETY: contract shape is re-validated by runGates at completion;
					// delegate only stores it. isObj(p.contract) was checked above.
					contract: p.contract as unknown as Contract,
					...(grants ? { grants } : {}),
					budget: asBudget(p.budget),
					parentTask: taskId,
				});
				return ok(req.id, result);
			}
			case "complete_task": {
				if (typeof p.taskId !== "string") return makeErr("bad_request", req.id, "complete_task needs taskId");
				const owned = this.assertOwnedTask(p.taskId, session.unitId);
				if (!owned) return makeErr("forbidden", req.id, "task is not assigned to this unit");
				const result = await this.store.completeTask(p.taskId, p.artifact);
				return ok(req.id, result);
			}
			case "escalate": {
				if (typeof p.taskId !== "string" || typeof p.question !== "string" || !Array.isArray(p.options)) {
					return makeErr("bad_request", req.id, "escalate needs taskId, question, options");
				}
				const owned = this.assertOwnedTask(p.taskId, session.unitId);
				if (!owned) return makeErr("forbidden", req.id, "task is not assigned to this unit");
				const result = this.store.escalate(p.taskId, p.question, (p.options as unknown[]).map(String));
				return ok(req.id, result);
			}
			case "meter": {
				if (typeof p.taskId !== "string") return makeErr("bad_request", req.id, "meter needs taskId");
				const owned = this.assertOwnedTask(p.taskId, session.unitId);
				if (!owned) return makeErr("forbidden", req.id, "task is not assigned to this unit");
				const result = this.store.meter(p.taskId, asBudget(p.usage));
				return ok(req.id, result);
			}
			default:
				return makeErr("bad_request", req.id, `unknown method ${String(req.method)}`);
		}
	}

	/** A worker may only complete/escalate/meter a task assigned to its own unit. */
	private assertOwnedTask(taskId: string, unitId: string): boolean {
		const t = this.store.getTask(taskId);
		return t !== null && t.toUnit === unitId;
	}

	/**
	 * Start listening on a Unix socket. `credentialOf` lets the caller observe a
	 * platform credential (uid); in dev the worker authenticates via a token in
	 * its `hello` params.
	 */
	listen(socketPath: string, credentialOf?: (sock: Socket) => PeerCredential): Promise<void> {
		this.socketPath = socketPath;
		try {
			rmSync(socketPath, { force: true });
		} catch {
			// best effort
		}
		const server = createServer((sock) => this.onConnection(sock, credentialOf?.(sock) ?? {}));
		this.server = server;
		return new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.removeListener("error", reject);
				try {
					chmodSync(socketPath, 0o600);
				} catch {
					// best effort on platforms without chmod semantics
				}
				resolve();
			});
		});
	}

	private onConnection(sock: Socket, baseCred: PeerCredential): void {
		const decoder = new LineDecoder();
		let session: Session | null = null;
		let taskId: string | null = null;
		sock.setEncoding("utf8");

		const fail = (code: RpcErrorCode, id: number, message: string): void => {
			sock.write(encodeLine(makeErr(code, id, message)));
		};

		sock.on("data", (chunk: string) => {
			let messages: unknown[];
			try {
				messages = decoder.push(chunk);
			} catch (e) {
				fail("bad_request", 0, (e as Error).message);
				sock.end();
				return;
			}
			for (const raw of messages) {
				void this.dispatch(raw, sock, baseCred, () => session, (s) => (session = s), () => taskId, (t) => (taskId = t), fail);
			}
		});
		sock.on("error", () => sock.destroy());
	}

	private async dispatch(
		raw: unknown,
		sock: Socket,
		baseCred: PeerCredential,
		getSession: () => Session | null,
		setSession: (s: Session) => void,
		getTask: () => string | null,
		setTask: (t: string | null) => void,
		fail: (code: RpcErrorCode, id: number, message: string) => void,
	): Promise<void> {
		if (!isObj(raw) || typeof raw.id !== "number" || typeof raw.method !== "string") {
			fail("bad_request", 0, "malformed request");
			return;
		}
		const req: RpcRequest = { id: raw.id, method: raw.method as RpcRequest["method"], params: isObj(raw.params) ? raw.params : {} };

		// First request must be `hello`, which authenticates and pins the task.
		if (!getSession()) {
			if (req.method !== "hello") {
				fail("unauthenticated", req.id, "first request must be hello");
				return;
			}
			const token = typeof req.params.token === "string" ? req.params.token : undefined;
			const unitId = authenticate(this.auth, { ...baseCred, ...(token ? { token } : {}) });
			if (!unitId) {
				fail("unauthenticated", req.id, "no credential maps to a unit");
				return;
			}
			setSession({ unitId });
			const pinnedTask = typeof req.params.taskId === "string" ? req.params.taskId : null;
			setTask(pinnedTask);
		}

		const session = getSession();
		if (!session) {
			fail("unauthenticated", req.id, "not authenticated");
			return;
		}
		try {
			const res = await this.handleRequest(req, session, getTask());
			sock.write(encodeLine(res));
		} catch (e) {
			fail("internal", req.id, (e as Error).message);
		}
	}

	async close(): Promise<void> {
		const server = this.server;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			this.server = null;
		}
		if (this.socketPath) {
			try {
				rmSync(this.socketPath, { force: true });
			} catch {
				// best effort
			}
			this.socketPath = null;
		}
	}
}
