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
import { chmodSync, chownSync, rmSync } from "node:fs";

import type { Budget, Decision } from "pi-agentic-core";
import { parseGrants } from "pi-agentic-core";
import type { Contract } from "pi-agentic-core";
import type { ControlStore } from "./store-control.ts";
import { syncUnits } from "./unit-sync.ts";
import {
	type Authenticator,
	type PeerCredential,
	type Principal,
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
	/** Called after `sync_units` adds units (the plane opens their per-unit sockets). */
	afterUnitsAdded?: () => Promise<unknown>;
}

/** A single authenticated session's identity. Admin sessions have no unit. */
interface Session {
	unitId: string;
	admin: boolean;
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

/**
 * `server.listen(path)` binds synchronously; doing it under umask 0177 means the socket is
 * never visible with looser permissions than 0600 before the explicit chown/chmod.
 */
export function listenPrivate(server: Server, socketPath: string, onListening: () => void): void {
	const prev = process.umask(0o177);
	try {
		server.listen(socketPath, onListening);
	} finally {
		process.umask(prev);
	}
}

export class ControlServer {
	private readonly store: ControlStore;
	private readonly auth: Authenticator;
	private readonly afterUnitsAdded: (() => Promise<unknown>) | undefined;
	private server: Server | null = null;
	private socketPath: string | null = null;
	// Live connections, so close() can tear them down (server.close() only stops listening).
	private readonly sockets = new Set<Socket>();
	// Serialize request handling across all connections: the store is a single
	// sqlite writer and nests BEGIN/COMMIT, so two concurrent handlers would
	// collide ("cannot start a transaction within a transaction").
	private tail: Promise<void> = Promise.resolve();
	// Per-unit sockets (identity = socket path), keyed by unit id.
	private readonly unitServers = new Map<string, { server: Server; path: string }>();

	constructor(opts: ControlServerOptions) {
		this.store = opts.store;
		this.auth = opts.auth;
		this.afterUnitsAdded = opts.afterUnitsAdded;
	}

	/** Build the read snapshot a worker needs to run the PDP locally. */
	snapshotFor(unitId: string, taskId: string | null): WorkerSnapshot {
		const unit = this.store.getUnit(unitId);
		const task = taskId ? this.store.getTask(taskId) : null;
		const remainingBudget = unit ? this.store.remainingBudget(unitId) : { tokens: 0, costUsd: 0, wallClockSec: 0 };
		return { unit, task, remainingBudget, notifications: unit ? this.store.listNotifications(unitId) : [] };
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
			case "record_decision": {
				if (session.admin) return makeErr("forbidden", req.id, "admin sessions have no unit to attribute decisions to");
				if (typeof p.toolName !== "string" || typeof p.allow !== "boolean" || !Array.isArray(p.paths)) {
					return makeErr("bad_request", req.id, "record_decision needs toolName, allow, paths");
				}
				const paths: Array<{ path: string; mode: "r" | "rw" }> = [];
				for (const e of p.paths as unknown[]) {
					const o = isObj(e) ? e : null;
					if (!o || typeof o.path !== "string" || (o.mode !== "r" && o.mode !== "rw")) {
						return makeErr("bad_request", req.id, "record_decision paths must be {path, mode}");
					}
					paths.push({ path: o.path, mode: o.mode });
				}
				const reason = typeof p.reason === "string" ? p.reason : "";
				const decision: Decision = p.allow ? { allow: true } : { allow: false, reason };
				// The unit and task come from the authenticated session, never the request.
				this.store.recordDecision(session.unitId, taskId, { toolName: p.toolName, paths }, decision);
				return ok(req.id, null);
			}
			case "list_notifications": {
				// Owner inbox (FR8): admin sees every unacked notice, a unit session its owner's.
				if (session.admin) return ok(req.id, this.store.listOwnerNotifications());
				const owner = this.store.getUnit(session.unitId)?.owner;
				if (!owner) return makeErr("forbidden", req.id, "caller has no owner");
				return ok(req.id, this.store.listOwnerNotifications(owner));
			}
			case "ack_owner_notification": {
				if (typeof p.id !== "string") return makeErr("bad_request", req.id, "ack_owner_notification needs id");
				const owner = session.admin ? undefined : this.store.getUnit(session.unitId)?.owner;
				if (!session.admin && !owner) return makeErr("forbidden", req.id, "caller has no owner");
				if (!this.store.ackOwnerNotification(owner, p.id)) return makeErr("not_found", req.id, `no unacked notification ${p.id} for this owner`);
				return ok(req.id, null);
			}
			case "ack_notification": {
				if (session.admin) return makeErr("forbidden", req.id, "admin sessions have no notifications");
				if (typeof p.id !== "string") return makeErr("bad_request", req.id, "ack_notification needs id");
				// Scoped to the authenticated unit: a unit can only ack its own notifications.
				if (!this.store.ackNotification(session.unitId, p.id)) return makeErr("not_found", req.id, `no unacked notification ${p.id} for this unit`);
				return ok(req.id, null);
			}
			case "list_approvals": {
				// Admin sees the whole inbox; a unit sees only its owner's approvals (ADR-0007).
				if (session.admin) return ok(req.id, this.store.listOpenApprovals());
				const owner = this.store.getUnit(session.unitId)?.owner;
				if (!owner) return makeErr("forbidden", req.id, "caller has no owner");
				return ok(req.id, this.store.listOpenApprovals(owner));
			}
			case "resolve_approval": {
				if (typeof p.id !== "string" || (p.decision !== "approved" && p.decision !== "denied")) {
					return makeErr("bad_request", req.id, "resolve_approval needs id and decision (approved|denied)");
				}
				const appr = this.store.getApproval(p.id);
				if (!appr) return makeErr("not_found", req.id, `unknown approval ${p.id}`);
				const choice = typeof p.choice === "string" ? p.choice : undefined;
				let decidedBy: string;
				if (session.admin) {
					decidedBy = "admin";
				} else {
					const owner = this.store.getUnit(session.unitId)?.owner;
					if (!owner || owner !== appr.owner) return makeErr("forbidden", req.id, "approval is not owned by this unit");
					decidedBy = owner;
				}
				const result = this.store.resolveApproval(p.id, p.decision, decidedBy, choice);
				return ok(req.id, result);
			}
			case "sync_units": {
				if (!session.admin) return makeErr("forbidden", req.id, "sync_units is admin-only");
				if (!Array.isArray(p.manifests)) return makeErr("bad_request", req.id, "sync_units needs manifests[]");
				const report = syncUnits(this.store, p.manifests, "admin");
				// New units need their per-unit sockets; failures are audited by the hook, never fatal here.
				if (report.added.length > 0 && this.afterUnitsAdded) await this.afterUnitsAdded();
				return ok(req.id, report);
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
			listenPrivate(server, socketPath, () => {
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

	/**
	 * Listen on an additional socket bound to exactly ONE unit (ADR-0003). The
	 * socket path is the identity: a connection here authenticates as `unitId`
	 * with no token, and a `hello` that claims another identity is rejected. The
	 * OS enforces who may connect: after listening, the socket is chgrp'd to
	 * `opts.gid` (the unit's group) and chmod'd to `opts.mode` (default 0660,
	 * i.e. owner = control plane, group = the unit's user only). Idempotent per
	 * unit when the path is unchanged. Fail-closed: if `opts.gid` is given and the
	 * chown/chmod fails, the socket is torn down and the error propagates.
	 */
	async listenUnit(socketPath: string, unitId: string, opts: { gid?: number; mode?: number } = {}): Promise<void> {
		const existing = this.unitServers.get(unitId);
		if (existing) {
			if (existing.path === socketPath) return;
			throw new Error(`unit ${unitId} already has a socket at ${existing.path}`);
		}
		try {
			rmSync(socketPath, { force: true });
		} catch {
			// best effort
		}
		const server = createServer((sock) => this.onConnection(sock, { boundUnit: unitId }));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			// Owner-only from the first instant: listen creates the socket under a private umask.
			listenPrivate(server, socketPath, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		try {
			if (opts.gid !== undefined) chownSync(socketPath, process.getuid?.() ?? -1, opts.gid);
			chmodSync(socketPath, opts.mode ?? 0o660);
		} catch (e) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(socketPath, { force: true });
			throw e;
		}
		this.unitServers.set(unitId, { server, path: socketPath });
	}

	private onConnection(sock: Socket, baseCred: PeerCredential): void {
		this.sockets.add(sock);
		sock.on("close", () => this.sockets.delete(sock));
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
			// Reject a version mismatch BEFORE establishing any session (fail-closed).
			const version = typeof req.params.version === "number" ? req.params.version : 0;
			if (version !== PROTOCOL_VERSION) {
				fail("version_mismatch", req.id, `server speaks protocol ${PROTOCOL_VERSION}`);
				sock.end();
				return;
			}
			const token = typeof req.params.token === "string" ? req.params.token : undefined;
			const claimed = typeof req.params.unitId === "string" ? req.params.unitId : undefined;
			const principal: Principal | null = authenticate(this.auth, {
				...baseCred,
				...(token ? { token } : {}),
				...(claimed !== undefined ? { claimedUnit: claimed } : {}),
			});
			if (!principal) {
				fail("unauthenticated", req.id, "no credential maps to a unit");
				return;
			}
			const newSession: Session = principal.kind === "admin" ? { unitId: "", admin: true } : { unitId: principal.unitId, admin: false };
			// A pinned task is only honoured if it is actually assigned to the caller's unit;
			// otherwise it would disclose a foreign task's goal/contract/grants and could be
			// used as a foreign parentTask on delegate.
			const pinnedTask = typeof req.params.taskId === "string" ? req.params.taskId : null;
			if (pinnedTask !== null && !newSession.admin) {
				const t = this.store.getTask(pinnedTask);
				if (!t || t.toUnit !== newSession.unitId) {
					fail("forbidden", req.id, "pinned task is not assigned to this unit");
					sock.end();
					return;
				}
			}
			setSession(newSession);
			setTask(pinnedTask);
		}

		const session = getSession();
		if (!session) {
			fail("unauthenticated", req.id, "not authenticated");
			return;
		}
		// Chain onto the serialization tail so transactional store calls never overlap.
		const run = this.tail.then(async () => {
			try {
				const res = await this.handleRequest(req, session, getTask());
				sock.write(encodeLine(res));
			} catch (e) {
				fail("internal", req.id, (e as Error).message);
			}
		});
		this.tail = run.catch(() => {});
		await run;
	}

	async close(): Promise<void> {
		const server = this.server;
		// Destroy live connections first: server.close() only stops accepting, it leaves
		// established sockets open, which would hang clients waiting on a reply.
		for (const sock of this.sockets) sock.destroy();
		this.sockets.clear();
		// Per-unit sockets (ADR-0003): stop listening and unlink each.
		for (const [, u] of this.unitServers) {
			await new Promise<void>((resolve) => u.server.close(() => resolve()));
			try {
				rmSync(u.path, { force: true });
			} catch {
				// best effort
			}
		}
		this.unitServers.clear();
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
