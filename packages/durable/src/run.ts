/**
 * runDurableTask: run ONE control-plane task inside ONE pi-durable Harness.
 *
 * Ownership model (ADR-0009): control.db stays authoritative for the task's
 * lifecycle; the pi-durable SQLite file `<ORG_DURABLE_DIR>/<taskId>.db` holds
 * only the in-unit conversation/tool execution state and is owned by exactly
 * one worker process at a time, enforced by `<taskId>.lock` (see lock.ts).
 *
 * Restart safety: the goal is submitted with requestId = taskId, so a restarted
 * worker finds the existing submission instead of submitting twice, and
 * `Harness.resume()` continues whatever the crashed process left pending.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENV_DURABLE_DIR, SocketControlClient, resolveUnitConfig, type ControlClient, type TaskRow, type UnitConfig } from "pi-agentic-control-plane";
import { deliveryFor } from "./notifications.ts";
import {
	assertManifestOutsideWritable,
	authSecretValues,
	ENV_DEV,
	ENV_MANIFEST,
	loadManifest,
	nearestRealpath,
	resolveShell,
	secretValuesOf,
	type RealpathResolver,
} from "pi-agentic/shared";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Conversation, type Extension, type ModelRef, type ReportInfo } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { acquireTaskLock, assertSafeTaskId, dbPathFor, type LockOptions } from "./lock.ts";
import { createOrgExtension, type OrgRunState } from "./org-extension.ts";

export type DurableOutcome =
	/** org_complete passed the gates (task done in control.db). */
	| "completed"
	/** Metering showed the unit over budget; the run was aborted (control plane escalated). */
	| "over_budget"
	/** The run was stopped fail-closed (metering or snapshot refresh failed) without proof it was in budget. */
	| "failed_closed"
	/** The task is escalated awaiting a human. */
	| "escalated"
	/** control.db says the task is not running (done/cancelled/pending/...): nothing was started. */
	| "task_not_running"
	/** The conversation ended (answered, failed or aborted) without completing the task. */
	| "ended_without_completion"
	/** Stopped by the caller's AbortSignal; pending work stays in storage for the next owner. */
	| "interrupted";

export interface DurableRunResult {
	outcome: DurableOutcome;
	taskId: string;
	/** control.db status of the task when the run ended. */
	taskStatus: TaskRow["status"] | null;
	/** True when a storage file for this task already existed (a restart). */
	resumed: boolean;
	submissionStatus: "done" | "unanswered" | null;
	overBudget: string[];
	escalationId: string | null;
	meteredSteps: number;
	/** pi-durable `onReport` types (task_faulted, extension_error, ...), in order. */
	reports: string[];
}

export interface DurableTaskOptions {
	/** Environment bag (ORG_UNIT_ID, ORG_CONTROL_DB, ORG_TASK_ID, ORG_CONTROL_SOCKET, ORG_UNIT_TOKEN, ORG_DURABLE_DIR). */
	env: Record<string, string | undefined>;
	/** pi-ai model collection. */
	models: Models;
	model: ModelRef;
	/** Workspace the unit's tools run in and relative paths resolve against. Default: process.cwd(). */
	cwd?: string;
	/** System instructions appended after extension sections. */
	instructions?: string;
	/** Tool extensions besides the org one. Default: pi-durable's read/write/edit/bash. */
	toolExtensions?: readonly Extension[];
	realpath?: RealpathResolver;
	/** Manifest reader (tests); default reads the file. */
	readManifest?: (path: string) => string;
	/** Clock for wall-clock metering and the Harness (epoch ms). Default Date.now. */
	now?: () => number;
	/** Client factory (tests); default connects a SocketControlClient. */
	openClient?: (config: UnitConfig) => Promise<ControlClient>;
	lock?: LockOptions;
	signal?: AbortSignal;
	context?: Context;
}

async function openSocketClient(config: UnitConfig): Promise<ControlClient> {
	if (!config.socketPath) throw new Error("ORG_CONTROL_SOCKET is required for a durable worker");
	const client = new SocketControlClient({
		unitId: config.unitId,
		taskId: config.taskId,
		socketPath: config.socketPath,
		...(config.token ? { token: config.token } : {}),
	});
	await client.connectAndHello();
	return client;
}

export function buildPrompt(task: TaskRow): string {
	return [
		`Task ${task.id}`,
		`Goal: ${task.goal}`,
		"",
		"Contract your artifact must satisfy (JSON):",
		JSON.stringify(task.contract, null, 2),
		"",
		"When finished, call org_complete with the artifact. Call org_escalate if you need a human decision.",
	].join("\n");
}

/** Input submitted when the control plane re-queued a settled task (generation >= 1). */
export function buildContinuationPrompt(task: TaskRow): string {
	return [
		`Task ${task.id} was re-queued by the control plane (generation ${task.generation}): the budget was extended or another attempt was granted.`,
		"Continue the task from where the conversation left off and call org_complete with the artifact when finished.",
	].join("\n");
}

/**
 * Idempotency key of the submission for a task generation. Generation 0 keeps
 * `requestId = taskId` (existing storages); each re-queue adds one key, so a
 * restarted worker re-finds its generation's submission instead of adding another.
 */
export function submissionRequestId(task: Pick<TaskRow, "id" | "generation">): string {
	return task.generation === 0 ? task.id : `${task.id}:${task.generation}`;
}

export async function runDurableTask(opts: DurableTaskOptions): Promise<DurableRunResult> {
	const resolved = resolveUnitConfig(opts.env);
	if (!resolved.ok) throw new Error(`durable worker: ${resolved.reason}`);
	const config = resolved.config;
	if (!config.enabled) throw new Error("durable worker: ORG_UNIT_ID / ORG_CONTROL_DB are not set");
	if (!config.taskId) throw new Error("durable worker: ORG_TASK_ID is required");
	if (!config.socketPath && !opts.openClient) throw new Error("durable worker: ORG_CONTROL_SOCKET is required");
	const durableDir = opts.env[ENV_DURABLE_DIR];
	if (!durableDir) throw new Error(`durable worker: ${ENV_DURABLE_DIR} is required`);
	const taskId = config.taskId;
	assertSafeTaskId(taskId);

	// FR1 + never trust the workspace: the manifest is read and validated before any state is touched,
	// and a manifest the unit could itself rewrite is refused outside dev mode. Fails closed.
	const dev = opts.env[ENV_DEV] === "1";
	const realpath = opts.realpath ?? nearestRealpath;
	const manifestPath = resolve(opts.env[ENV_MANIFEST] || join(opts.cwd ?? process.cwd(), "unit.json"));
	const manifest = loadManifest(opts.readManifest ?? ((p) => readFileSync(p, "utf8")), manifestPath, config.unitId);
	if (!dev) assertManifestOutsideWritable(manifest, manifestPath, realpath);
	const secrets = secretValuesOf(manifest, opts.env, authSecretValues(opts.env));
	const shell = resolveShell(opts.env, dev);

	mkdirSync(durableDir, { recursive: true, mode: 0o700 });
	const lock = acquireTaskLock(durableDir, taskId, opts.lock);
	let client: ControlClient | null = null;
	let harness: Harness | null = null;
	try {
		client = await (opts.openClient ?? openSocketClient)(config);
		await client.refresh();
		const task = client.currentTask();
		if (!task) throw new Error(`durable worker: control plane has no task ${taskId}`);
		const base: DurableRunResult = {
			outcome: "task_not_running",
			taskId,
			taskStatus: task.status,
			resumed: false,
			submissionStatus: null,
			overBudget: [],
			escalationId: null,
			meteredSteps: 0,
			reports: [],
		};
		// control.db is authoritative: only a running task is worked on.
		if (task.status !== "running") return base;

		const dbPath = dbPathFor(durableDir, taskId);
		const resumed = existsSync(dbPath);
		const context = opts.context ?? BACKGROUND_CONTEXT;
		const now = opts.now ?? Date.now;
		const cwd = opts.cwd ?? process.cwd();
		const reports: string[] = [];

		let conversation: Conversation | undefined;
		const org = createOrgExtension({
			client,
			taskId,
			cwd,
			realpath,
			unitId: config.unitId,
			shell,
			secrets,
			now,
			abortRun: () => {
				void conversation?.abort(context).catch(() => {});
			},
		});
		const registry = createRegistry();
		for (const ext of opts.toolExtensions ?? [CodingTools]) registry.install(ext);
		registry.install(org.extension);

		const storage = await openNodeSqliteStorage(dbPath);
		harness = await Harness.open(
			storage,
			{
				models: opts.models,
				registry,
				now,
				env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
				onReport: (_e: unknown, info: ReportInfo) => {
					reports.push(info.type);
				},
			},
			context,
		);
		conversation = await harness.root(context, {
			agent: { model: opts.model, cwd, ...(opts.instructions ? { instructions: opts.instructions } : {}) },
		});
		// Continue whatever a crashed owner left pending before (re)submitting.
		harness.resume();
		// The goal is submitted once (generation 0). Each control-plane re-queue
		// submits exactly one continuation onto the same conversation; a crash
		// within a generation re-finds that generation's submission.
		if (task.generation > 0) {
			await conversation.submit({ type: "input", content: buildPrompt(task), requestId: taskId }, context);
		}
		const delivery = deliveryFor(durableDir, taskId, task.generation, client.snapshot().notifications);
		const body = task.generation === 0 ? buildPrompt(task) : buildContinuationPrompt(task);
		const submission = await conversation.submit(
			{ type: "input", content: delivery.text ? `${body}\n\n${delivery.text}` : body, requestId: submissionRequestId(task) },
			context,
		);
		// Delivered: ack so each notification is shown once. A failed ack only means it is shown again.
		for (const id of delivery.ids) await client.ackNotification(id).catch(() => undefined);

		const onAbort = () => void conversation?.abort(context).catch(() => {});
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts.signal?.aborted) onAbort();
		let settled: Awaited<ReturnType<typeof submission.wait>>;
		try {
			settled = await submission.wait(context);
		} finally {
			opts.signal?.removeEventListener("abort", onAbort);
		}

		await client.refresh().catch(() => undefined);
		return finish({ ...base, resumed, taskStatus: client.currentTask()?.status ?? null, submissionStatus: settled.status, reports }, org.state, opts.signal?.aborted === true);
	} finally {
		try {
			await harness?.close(opts.context ?? BACKGROUND_CONTEXT);
		} finally {
			try {
				await client?.close();
			} finally {
				lock.release();
			}
		}
	}
}

function finish(r: DurableRunResult, s: OrgRunState, interrupted: boolean): DurableRunResult {
	const out: DurableRunResult = { ...r, overBudget: s.overBudget, escalationId: s.escalationId, meteredSteps: s.meteredSteps };
	if (s.completed || r.taskStatus === "done") return { ...out, outcome: "completed" };
	if (s.tripped) return { ...out, outcome: s.overBudget.length > 0 ? "over_budget" : "failed_closed" };
	if (r.taskStatus === "escalated") return { ...out, outcome: "escalated" };
	if (interrupted) return { ...out, outcome: "interrupted" };
	return { ...out, outcome: "ended_without_completion" };
}
