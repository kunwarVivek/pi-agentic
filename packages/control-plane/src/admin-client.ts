/**
 * AdminClient: a thin operator-facing RPC client (ADR-0007). It connects to the
 * ControlServer, authenticates with the admin token (human root), and exposes
 * only the inbox verbs the `org` CLI needs: list and resolve approvals. It is
 * deliberately NOT a ControlClient — an operator has no unit identity, no task,
 * and no PDP to run — so it skips the snapshot handshake machinery and speaks
 * the protocol directly.
 */

import { type Socket, connect } from "node:net";

import type { SyncReport } from "./unit-sync.ts";
import type { ApprovalRow, NotificationRow } from "./store-control.ts";
import {
	LineDecoder,
	PROTOCOL_VERSION,
	type RpcMethod,
	type RpcResponse,
	encodeLine,
} from "./protocol.ts";

interface Pending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

export interface AdminClientOptions {
	socketPath: string;
	/** Operator admin token (human root). */
	token: string;
}

export class AdminClient {
	private readonly socketPath: string;
	private readonly token: string;

	private sock: Socket | null = null;
	private readonly decoder = new LineDecoder();
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private connected: Promise<void> | null = null;

	constructor(opts: AdminClientOptions) {
		this.socketPath = opts.socketPath;
		this.token = opts.token;
	}

	/** Open the socket and perform the hello handshake as admin. Idempotent. */
	connectAndHello(): Promise<void> {
		if (this.connected) return this.connected;
		this.connected = new Promise<void>((resolve, reject) => {
			const sock = connect(this.socketPath);
			this.sock = sock;
			sock.setEncoding("utf8");
			sock.on("data", (chunk: string) => this.onData(chunk));
			sock.on("error", (e) => {
				this.failAll(e);
				reject(e);
			});
			sock.on("close", () => this.failAll(new Error("connection closed by control plane")));
			sock.once("connect", () => {
				this.call("hello", { version: PROTOCOL_VERSION, token: this.token }).then(() => resolve(), reject);
			});
		});
		return this.connected;
	}

	private onData(chunk: string): void {
		let messages: unknown[];
		try {
			messages = this.decoder.push(chunk);
		} catch (e) {
			this.failAll(e as Error);
			return;
		}
		for (const raw of messages) {
			const res = raw as RpcResponse;
			if (typeof res?.id !== "number") continue;
			const p = this.pending.get(res.id);
			if (!p) continue;
			this.pending.delete(res.id);
			if (res.ok) p.resolve(res.result);
			else p.reject(new Error(`${res.error.code}: ${res.error.message}`));
		}
	}

	private failAll(err: Error): void {
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
	}

	/** Reconcile the running control plane's units with raw (unparsed) unit.json manifests. Admin-only. */
	async syncUnits(manifests: readonly unknown[]): Promise<SyncReport> {
		await this.connectAndHello();
		return (await this.call("sync_units", { manifests })) as SyncReport;
	}

	private call(method: RpcMethod, params: Record<string, unknown>): Promise<unknown> {
		const sock = this.sock;
		if (!sock) return Promise.reject(new Error("socket not connected"));
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			sock.write(encodeLine({ id, method, params }));
		});
	}

	async listApprovals(): Promise<ApprovalRow[]> {
		await this.connectAndHello();
		return (await this.call("list_approvals", {})) as ApprovalRow[];
	}

	async resolveApproval(id: string, decision: "approved" | "denied", choice?: string): Promise<ApprovalRow> {
		await this.connectAndHello();
		return (await this.call("resolve_approval", { id, decision, ...(choice !== undefined ? { choice } : {}) })) as ApprovalRow;
	}

	/** Unacknowledged notifications across every owner (owner inbox, FR8). */
	async listNotifications(): Promise<NotificationRow[]> {
		await this.connectAndHello();
		return (await this.call("list_notifications", {})) as NotificationRow[];
	}

	async ackNotification(id: string): Promise<void> {
		await this.connectAndHello();
		await this.call("ack_owner_notification", { id });
	}

	close(): void {
		this.failAll(new Error("client closed"));
		this.sock?.end();
		this.sock?.destroy();
		this.sock = null;
		this.connected = null;
	}
}
