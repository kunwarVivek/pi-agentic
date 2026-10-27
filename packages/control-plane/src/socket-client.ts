/**
 * SocketControlClient: a ControlClient backed by a Unix-domain socket to the
 * control plane (ADR-0003). It opens the connection, performs the `hello`
 * handshake (authenticating with a dev token and pinning its current task),
 * and caches the returned WorkerSnapshot so the tool_call PDP can decide
 * synchronously. Mutations round-trip to the ControlServer.
 */

import { type Socket, connect } from "node:net";

import { formatGrant } from "@agentic-pi/core";
import type { Budget } from "@agentic-pi/core";
import type {
	ApprovalRow,
	CompleteResult,
	DelegateResult,
	MeterResult,
} from "./store-control.ts";
import {
	LineDecoder,
	PROTOCOL_VERSION,
	type RpcMethod,
	type RpcResponse,
	encodeLine,
} from "./protocol.ts";
import {
	BaseControlClient,
	type ClientDelegateInput,
	type WorkerSnapshot,
} from "./control-client.ts";

const EMPTY_BUDGET: Budget = { tokens: 0, costUsd: 0, wallClockSec: 0 };
const EMPTY_SNAPSHOT: WorkerSnapshot = { unit: null, task: null, remainingBudget: EMPTY_BUDGET };

interface Pending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

export interface SocketClientOptions {
	unitId: string;
	taskId: string | null;
	socketPath: string;
	/** Dev-mode bearer token presented at hello (uid auth needs no token). */
	token?: string;
}

export class SocketControlClient extends BaseControlClient {
	readonly unitId: string;
	private readonly taskId: string | null;
	private readonly socketPath: string;
	private readonly token: string | undefined;

	private sock: Socket | null = null;
	private readonly decoder = new LineDecoder();
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private cached: WorkerSnapshot = EMPTY_SNAPSHOT;
	private connected: Promise<void> | null = null;

	constructor(opts: SocketClientOptions) {
		super();
		this.unitId = opts.unitId;
		this.taskId = opts.taskId;
		this.socketPath = opts.socketPath;
		this.token = opts.token;
	}

	/** Open the socket and perform the hello handshake. Idempotent. */
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
			sock.once("connect", () => {
				this.call("hello", {
					version: PROTOCOL_VERSION,
					...(this.token ? { token: this.token } : {}),
					...(this.taskId ? { taskId: this.taskId } : {}),
				}).then(
					(res) => {
						const r = res as { unitId: string; snapshot: WorkerSnapshot };
						this.cached = r.snapshot ?? EMPTY_SNAPSHOT;
						resolve();
					},
					reject,
				);
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

	private call(method: RpcMethod, params: Record<string, unknown>): Promise<unknown> {
		const sock = this.sock;
		if (!sock) return Promise.reject(new Error("socket not connected"));
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			sock.write(encodeLine({ id, method, params }));
		});
	}

	snapshot(): WorkerSnapshot {
		return this.cached;
	}

	async refresh(): Promise<WorkerSnapshot> {
		await this.connectAndHello();
		const res = (await this.call("snapshot", {})) as WorkerSnapshot;
		this.cached = res ?? EMPTY_SNAPSHOT;
		return this.cached;
	}

	async delegate(input: ClientDelegateInput): Promise<DelegateResult> {
		await this.connectAndHello();
		return (await this.call("delegate", {
			toUnit: input.toUnit,
			goal: input.goal,
			contract: input.contract,
			...(input.grants ? { grants: input.grants.map((g) => formatGrant(g)) } : {}),
			budget: input.budget,
			...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
		})) as DelegateResult;
	}

	async completeTask(taskId: string, artifact: unknown): Promise<CompleteResult> {
		await this.connectAndHello();
		return (await this.call("complete_task", { taskId, artifact })) as CompleteResult;
	}

	async escalate(taskId: string, question: string, options: string[]): Promise<ApprovalRow> {
		await this.connectAndHello();
		return (await this.call("escalate", { taskId, question, options })) as ApprovalRow;
	}

	async meter(taskId: string, usage: Budget): Promise<MeterResult> {
		await this.connectAndHello();
		return (await this.call("meter", { taskId, usage })) as MeterResult;
	}

	async listApprovals(): Promise<ApprovalRow[]> {
		await this.connectAndHello();
		return (await this.call("list_approvals", {})) as ApprovalRow[];
	}

	async resolveApproval(id: string, decision: "approved" | "denied", choice?: string): Promise<ApprovalRow> {
		await this.connectAndHello();
		return (await this.call("resolve_approval", { id, decision, ...(choice !== undefined ? { choice } : {}) })) as ApprovalRow;
	}

	close(): void {
		this.failAll(new Error("client closed"));
		this.sock?.end();
		this.sock?.destroy();
		this.sock = null;
		this.connected = null;
	}
}
