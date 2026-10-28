/**
 * Control store (SPEC S2): the single writer of `control.db`.
 *
 * Owns units, tasks, artifacts, approvals, per-unit budgets and the audit chain.
 * All cross-unit authority decisions reuse the pure core (grants, delegation, gates,
 * budget, audit) so this layer only adds persistence, state machines and clock.
 *
 * Persistence is `node:sqlite` in WAL mode, one writer process (ADR-0001, ADR-0003).
 * Time is injected (`clock`) so lifecycle and TTL logic is testable with a fake clock.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { type AuditAnchor, type AnchorCheck, type ChainedEntry, GENESIS, buildAnchor, canonicalJson, chain, verify, verifyAgainstAnchor } from "pi-agentic-core";
import { add, sub, exhausted, fits, remaining } from "pi-agentic-core";
import { ZERO } from "pi-agentic-core";
import { type Contract, type GateResult, type JudgeFn, runGates } from "pi-agentic-core";
import { type Grant, effectiveGrants, formatGrant, parseGrants } from "pi-agentic-core";
import type { Budget, Decision, Manifest, ToolRequest } from "pi-agentic-core";
import { type DelegationCheck, type OrgSnapshot, type UnitStatus, checkDelegation } from "pi-agentic-core";

export type TaskStatus = "pending" | "running" | "done" | "rejected" | "escalated" | "cancelled";
export type ApprovalStatus = "open" | "approved" | "denied" | "expired";

/** Any JSON value — the shape a stored artifact can take before a contract validates it. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface TaskRow {
	id: string;
	fromUnit: string;
	toUnit: string;
	goal: string;
	contract: Contract;
	grants: Grant[] | null;
	budget: Budget;
	used: Budget;
	deadline: string | null;
	status: TaskStatus;
	parentTask: string | null;
	attempts: number;
	/**
	 * Resume generation: 0 at creation, +1 on every re-queue of a settled task
	 * (approved escalation, retry of a rejected task). Workers key their
	 * continuation submission on it, so one re-queue yields exactly one continuation.
	 */
	generation: number;
	reason: string | null;
	artifactHash: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ApprovalRow {
	id: string;
	taskId: string;
	question: string;
	options: string[];
	owner: string;
	status: ApprovalStatus;
	decision: string | null;
	decidedBy: string | null;
	expiresAt: string;
	createdAt: string;
	/** Unit currently holding the approval (climbs by unit id on expiry); null only for pre-migration orphans. */
	holderUnitId: string | null;
}

export type NotificationKind = "task.done" | "task.escalated" | "task.rejected" | "unit.lifecycle";

/** A queued message for a unit (FR4 parent notification, FR8 lifecycle). */
export interface NotificationRow {
	id: string;
	unitId: string;
	kind: NotificationKind;
	subject: string;
	data: JsonValue;
	createdAt: string;
	ackedAt: string | null;
	/** Owner of the addressed unit at notification time (owner inbox, FR8); null for rows predating the column. */
	owner: string | null;
}

export interface UnitRow extends Omit<Manifest, "secrets" | "trust"> {
	status: UnitStatus;
	used: Budget;
	reserved: Budget;
	lastActive: string | null;
	createdAt: string | null;
}

/** A recorded eval run for a unit (SPEC FR8 / G9). */
export interface EvalRow {
	id: string;
	unitId: string;
	suite: string;
	passed: number;
	total: number;
	at: string;
}

/** One unit status transition performed by the scheduler sweep. */
export interface LifecycleTransition {
	unitId: string;
	from: UnitStatus;
	to: UnitStatus;
	reason: "expired" | "idle" | "low_eval";
}

export interface DelegateInput {
	fromUnit: string;
	toUnit: string;
	goal: string;
	contract: Contract;
	grants?: Grant[];
	budget: Budget;
	deadline?: string | null;
	parentTask?: string | null;
}

export type DelegateResult = { ok: true; taskId: string } | (DelegationCheck & { ok: false });

export type CompleteResult =
	| { ok: true; status: "done"; gate: GateResult; artifactHash: string }
	| { ok: false; status: "rejected" | "escalated"; gate: GateResult; attempts: number; artifactHash: string }
	| { ok: false; status: "error"; reason: string };

export interface MeterResult {
	used: Budget;
	overBudget: Array<keyof Budget>;
	/** Escalation approval created by THIS call (first over-budget meter), else null. */
	escalation: ApprovalRow | null;
}

export interface ControlStoreOptions {
	/** Injected clock returning epoch milliseconds. Defaults to Date.now. */
	clock?: () => number;
	/** ID generator (testability). Defaults to random hex. */
	genId?: (prefix: string) => string;
	/** Approval TTL in milliseconds (SPEC FR5, default 24h). */
	approvalTtlMs?: number;
	/** Idle threshold before a unit is retired (SPEC FR8, default 90 days). */
	retireIdleMs?: number;
	/** Gate judge (ADR-0005). Contracts with `judge: true` are rejected at delegate when absent. */
	judge?: JudgeFn;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  parent TEXT,
  owner TEXT NOT NULL,
  grants TEXT NOT NULL,
  budget TEXT NOT NULL,
  limits TEXT NOT NULL,
  expires_at TEXT,
  min_eval REAL,
  status TEXT NOT NULL DEFAULT 'active',
  used TEXT NOT NULL,
  reserved TEXT NOT NULL,
  last_active TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  from_unit TEXT NOT NULL,
  to_unit TEXT NOT NULL,
  goal TEXT NOT NULL,
  contract TEXT NOT NULL,
  grants TEXT,
  budget TEXT NOT NULL,
  used TEXT NOT NULL DEFAULT '{"tokens":0,"costUsd":0,"wallClockSec":0}',
  deadline TEXT,
  status TEXT NOT NULL,
  parent_task TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  artifact_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_to_unit ON tasks(to_unit, status);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task);
CREATE TABLE IF NOT EXISTS artifacts (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  owner TEXT NOT NULL,
  holder_unit_id TEXT,
  status TEXT NOT NULL,
  decision TEXT,
  decided_by TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evals (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  suite TEXT NOT NULL,
  passed INTEGER NOT NULL,
  total INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evals_unit ON evals(unit_id);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  owner TEXT,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acked_at TEXT
);
CREATE INDEX IF NOT EXISTS notifications_unit ON notifications(unit_id, acked_at);
`;

/** The audit chain is append-only at the DB level (FR7): any UPDATE or DELETE aborts. */
const AUDIT_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
`;

const DAY_MS = 24 * 60 * 60 * 1000;

export class ControlStore {
	private readonly db: DatabaseSync;
	private readonly clock: () => number;
	private readonly genId: (prefix: string) => string;
	private readonly approvalTtlMs: number;
	private readonly retireIdleMs: number;
	private readonly judge: JudgeFn | undefined;
	/** Filesystem path to control.db (so the dispatcher can wire ORG_CONTROL_DB). */
	readonly dbPath: string;

	constructor(path: string, opts: ControlStoreOptions = {}) {
		this.dbPath = path;
		this.clock = opts.clock ?? Date.now;
		this.genId = opts.genId ?? ((p) => `${p}_${createHash("sha256").update(`${Math.random()}${this.clock()}`).digest("hex").slice(0, 16)}`);
		this.approvalTtlMs = opts.approvalTtlMs ?? DAY_MS;
		this.retireIdleMs = opts.retireIdleMs ?? 90 * DAY_MS;
		this.judge = opts.judge;
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		this.db.exec(SCHEMA);
		this.db.exec(AUDIT_TRIGGERS);
		this.ensureColumns();
	}

	/** Defensive migration for DBs created before a column existed (v0.x, no formal migrations). */
	private ensureColumns(): void {
		const cols = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
		if (!cols.some((c) => c.name === "used")) {
			this.db.exec(`ALTER TABLE tasks ADD COLUMN used TEXT NOT NULL DEFAULT '{"tokens":0,"costUsd":0,"wallClockSec":0}'`);
		}
		if (!cols.some((c) => c.name === "generation")) {
			this.db.exec("ALTER TABLE tasks ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
		}
		const approvalCols = this.db.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>;
		if (!approvalCols.some((c) => c.name === "holder_unit_id")) {
			this.db.exec("ALTER TABLE approvals ADD COLUMN holder_unit_id TEXT");
			// Old rows: the holder is the unit on the executing unit's ancestor chain whose owner currently holds the approval.
			const old = this.db.prepare("SELECT id, task_id, owner FROM approvals").all() as Array<{ id: string; task_id: string; owner: string }>;
			for (const r of old) {
				const task = this.getTask(r.task_id);
				const holder = task ? this.unitByOwnerNear(task.toUnit, r.owner) : null;
				if (holder) this.db.prepare("UPDATE approvals SET holder_unit_id=? WHERE id=?").run(holder.id, r.id);
			}
		}
		const noteCols = this.db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>;
		if (!noteCols.some((c) => c.name === "owner")) {
			this.db.exec("ALTER TABLE notifications ADD COLUMN owner TEXT");
			// Old rows: the addressed unit's current owner.
			this.db.exec("UPDATE notifications SET owner = (SELECT owner FROM units WHERE units.id = notifications.unit_id)");
		}
		this.db.exec("CREATE INDEX IF NOT EXISTS notifications_owner ON notifications(owner, acked_at)");
	}

	close(): void {
		this.db.close();
	}

	private nowIso(): string {
		return new Date(this.clock()).toISOString();
	}

	// ---- units ---------------------------------------------------------------

	addUnit(m: Manifest, status: UnitStatus = "active"): void {
		this.db
			.prepare(
				`INSERT INTO units (id, path, parent, owner, grants, budget, limits, expires_at, min_eval, status, used, reserved, last_active, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				m.id,
				m.path,
				m.parent,
				m.owner,
				JSON.stringify(m.grants.map(formatGrant)),
				JSON.stringify(m.budget),
				JSON.stringify(m.limits),
				m.expiresAt,
				m.minEval,
				status,
				JSON.stringify(ZERO),
				JSON.stringify(ZERO),
				null,
				this.nowIso(),
			);
		this.append("unit", m.owner, "unit.add", m.id, { path: m.path, parent: m.parent });
	}

	/**
	 * Apply an authored manifest to an EXISTING unit: owner, parent, grants, budget, limits,
	 * expiresAt, minEval. Status, usage and path are never touched (a path change would move the
	 * unit's workspace, so it is refused). A parent that is unknown or would create a cycle is
	 * refused. Audited as `unit.update` with the before/after of each changed field.
	 * Returns the changed field names (empty = no write, no audit entry).
	 */
	updateUnit(m: Manifest, actor = "admin"): string[] {
		const cur = this.getUnit(m.id);
		if (!cur) throw new Error(`unknown unit ${m.id}`);
		if (cur.path !== m.path) throw new Error(`unit ${m.id}: path change ${cur.path} -> ${m.path} is not supported`);
		if (m.parent !== cur.parent && m.parent !== null) {
			if (!this.getUnit(m.parent)) throw new Error(`unit ${m.id}: unknown parent ${m.parent}`);
			const seen = new Set<string>([m.id]);
			for (let p: string | null = m.parent; p !== null; p = this.getUnit(p)?.parent ?? null) {
				if (seen.has(p)) throw new Error(`unit ${m.id}: parent ${m.parent} would create a cycle`);
				seen.add(p);
			}
		}
		const fmt = (gs: readonly Grant[]): string[] => gs.map(formatGrant).sort();
		const diffs: Array<[string, unknown, unknown]> = [
			["owner", cur.owner, m.owner],
			["parent", cur.parent, m.parent],
			["grants", fmt(cur.grants), fmt(m.grants)],
			["budget", cur.budget, m.budget],
			["limits", cur.limits, m.limits],
			["expiresAt", cur.expiresAt, m.expiresAt],
			["minEval", cur.minEval, m.minEval],
		];
		const changed = diffs.filter(([, a, b]) => canonicalJson(a) !== canonicalJson(b));
		if (changed.length === 0) return [];
		this.db
			.prepare("UPDATE units SET owner = ?, parent = ?, grants = ?, budget = ?, limits = ?, expires_at = ?, min_eval = ? WHERE id = ?")
			.run(m.owner, m.parent, JSON.stringify(m.grants.map(formatGrant)), JSON.stringify(m.budget), JSON.stringify(m.limits), m.expiresAt, m.minEval, m.id);
		this.append("unit", actor, "unit.update", m.id, { changed: Object.fromEntries(changed.map(([k, from, to]) => [k, { from, to }])) });
		return changed.map(([k]) => k);
	}

	getUnit(id: string): UnitRow | null {
		const r = this.db.prepare("SELECT * FROM units WHERE id = ?").get(id) as Record<string, unknown> | undefined;
		return r ? rowToUnit(r) : null;
	}

	listUnits(): UnitRow[] {
		return (this.db.prepare("SELECT * FROM units").all() as Array<Record<string, unknown>>).map(rowToUnit);
	}

	setUnitStatus(id: string, status: UnitStatus, actor = "control"): void {
		const info = this.db.prepare("UPDATE units SET status = ? WHERE id = ?").run(status, id);
		if (info.changes === 0) throw new Error(`unknown unit ${id}`);
		this.append("unit", actor, "unit.status", id, { status });
	}

	private unitsSnapshot(): OrgSnapshot["units"] {
		return new Map(this.listUnits().map((u) => [u.id, u]));
	}

	// ---- tasks ---------------------------------------------------------------

	getTask(id: string): TaskRow | null {
		const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
		return r ? rowToTask(r) : null;
	}

	/** Tasks in a given status, oldest first (dispatcher inbox poll). */
	listTasksByStatus(status: TaskStatus): TaskRow[] {
		const rows = this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC").all(status) as Record<string, unknown>[];
		return rows.map(rowToTask);
	}

	/** Units executing along the parent-task chain, root first, ending at `fromUnit`. */
	private taskChainUnits(fromUnit: string, parentTask: string | null): string[] {
		const chainUnits = [fromUnit];
		let cur = parentTask;
		const seen = new Set<string>();
		while (cur !== null && !seen.has(cur)) {
			seen.add(cur);
			const t = this.getTask(cur);
			if (!t) break;
			chainUnits.unshift(t.fromUnit);
			cur = t.parentTask;
		}
		return chainUnits;
	}

	private callerGrants(fromUnit: string, parentTask: string | null): Grant[] {
		const unit = this.getUnit(fromUnit);
		if (!unit) return [];
		if (parentTask === null) return [...unit.grants];
		const pt = this.getTask(parentTask);
		return effectiveGrants(unit.grants, pt?.grants ?? undefined);
	}

	/** Count open child tasks created under a parent task (fan-out window). */
	private openChildren(parentTask: string | null, fromUnit?: string): number {
		if (parentTask === null) {
			// Root-initiated work: the fan-out window is this caller's own open root tasks,
			// not every root task in the org (FR3 fanout is per-unit).
			const r = this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_task IS NULL AND from_unit = ? AND status IN ('pending','running','escalated')").get(fromUnit ?? "") as { n: number };
			return r.n;
		}
		const r = this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_task = ? AND status IN ('pending','running','escalated')").get(parentTask) as { n: number };
		return r.n;
	}

	// ---- delegation (FR3) ----------------------------------------------------

	delegate(input: DelegateInput): DelegateResult {
		const parentTask = input.parentTask ?? null;
		const from = this.getUnit(input.fromUnit);
		if (!from) return { ok: false, code: "unknown_from", reason: `unknown unit ${input.fromUnit}` };
		if (input.contract.judge && !this.judge) {
			const reason = "contract requires a judge but this control plane has none configured";
			this.append("task", input.fromUnit, "delegate.reject", input.toUnit, { code: "judge_unavailable", reason });
			return { ok: false, code: "judge_unavailable", reason };
		}

		const snapshot: OrgSnapshot = {
			units: this.unitsSnapshot(),
			callerGrants: this.callerGrants(input.fromUnit, parentTask),
			callerUsed: from.used,
			callerReserved: from.reserved,
			taskChainUnits: this.taskChainUnits(input.fromUnit, parentTask),
			openChildren: this.openChildren(parentTask, input.fromUnit),
		};

		const check = checkDelegation(
			{ fromUnit: input.fromUnit, toUnit: input.toUnit, parentTaskId: parentTask, grants: input.grants, budget: input.budget },
			snapshot,
		);
		if (!check.ok) {
			this.append("task", input.fromUnit, "delegate.reject", input.toUnit, { code: check.code, reason: check.reason });
			return { ...check, ok: false };
		}

		const id = this.genId("task");
		const now = this.nowIso();
		const tx = this.db.prepare(
			`INSERT INTO tasks (id, from_unit, to_unit, goal, contract, grants, budget, deadline, status, parent_task, attempts, reason, artifact_hash, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, NULL, ?, ?)`,
		);
		this.db.exec("BEGIN");
		try {
			tx.run(
				id,
				input.fromUnit,
				input.toUnit,
				input.goal,
				JSON.stringify(input.contract),
				input.grants ? JSON.stringify(input.grants.map(formatGrant)) : null,
				JSON.stringify(input.budget),
				input.deadline ?? null,
				parentTask,
				now,
				now,
			);
			// Reserve the delegated budget against the caller (FR6).
			this.setBudget(input.fromUnit, from.used, add(from.reserved, input.budget));
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
		this.append("task", input.fromUnit, "delegate", id, { toUnit: input.toUnit, budget: input.budget, parentTask });
		return { ok: true, taskId: id };
	}

	/** Mark a pending task as running (the dispatcher has started the worker). */
	startTask(id: string): void {
		const t = this.requireTask(id);
		if (t.status !== "pending") throw new Error(`task ${id} is ${t.status}, not pending`);
		this.setTaskStatus(id, "running");
		this.touchUnit(t.toUnit);
	}

	// ---- completion (FR4) ----------------------------------------------------

	async completeTask(id: string, artifact: unknown, judge?: JudgeFn): Promise<CompleteResult> {
		const first = this.getTask(id);
		if (!first) return { ok: false, status: "error", reason: `unknown task ${id}` };
		if (first.status === "done" || first.status === "escalated" || first.status === "cancelled")
			return { ok: false, status: "error", reason: `task ${id} is ${first.status}` };

		const artifactHash = this.storeArtifact(artifact);
		this.touchUnit(first.toUnit);
		const gate = await runGates(first.contract, artifact, judge ?? this.judge);
		// The gates may await a judge: the task can have been cancelled/completed/escalated meanwhile.
		const t = this.getTask(id);
		if (!t) return { ok: false, status: "error", reason: `unknown task ${id}` };
		if (t.status === "done" || t.status === "escalated" || t.status === "cancelled")
			return { ok: false, status: "error", reason: `task ${id} is ${t.status}` };
		const attempts = t.attempts + 1;

		if (gate.pass) {
			this.db.exec("BEGIN");
			try {
				this.db.prepare("UPDATE tasks SET status='done', attempts=?, reason=NULL, artifact_hash=?, updated_at=? WHERE id=?")
					.run(attempts, artifactHash, this.nowIso(), id);
				this.releaseToParent(t);
				this.db.exec("COMMIT");
			} catch (e) {
				this.db.exec("ROLLBACK");
				throw e;
			}
			this.append("task", t.toUnit, "complete", id, { artifactHash, stages: gate.stages });
			this.notify(t.fromUnit, "task.done", id, { artifactHash, toUnit: t.toUnit });
			return { ok: true, status: "done", gate, artifactHash };
		}

		const reason = `${gate.stage}: ${gate.reasons.join("; ")}`;
		const limit = this.getUnit(t.fromUnit)?.limits.maxAttempts ?? 2;
		this.db.exec("BEGIN");
		try {
			this.db.prepare("UPDATE tasks SET attempts=?, reason=?, artifact_hash=?, updated_at=? WHERE id=?")
				.run(attempts, reason, artifactHash, this.nowIso(), id);
			if (attempts >= limit) {
				// Out of attempts: a real approval row (inbox + expiry climb), not a bare status flag (FR4/FR5).
				this.append("task", t.toUnit, "complete.escalate", id, { reason, attempts });
				this.escalate(id, `attempts exhausted (${attempts}/${limit}): ${reason}`, ["retry", "cancel"]);
				this.db.exec("COMMIT");
				return { ok: false, status: "escalated", gate, attempts, artifactHash };
			}
			// Below the limit: reject, then re-queue so the dispatcher re-runs it (FR4).
			this.setTaskStatus(id, "rejected");
			this.append("task", t.toUnit, "complete.reject", id, { reason, attempts });
			this.notify(t.fromUnit, "task.rejected", id, { reason, attempts });
			this.retryTask(id);
			this.db.exec("COMMIT");
			return { ok: false, status: "rejected", gate, attempts, artifactHash };
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	/** Re-open a rejected task for another attempt (dispatcher retry path). */
	retryTask(id: string): void {
		const t = this.requireTask(id);
		if (t.status !== "rejected") throw new Error(`task ${id} is ${t.status}, not rejected`);
		this.db.prepare("UPDATE tasks SET status='pending', generation=generation+1, updated_at=? WHERE id=?").run(this.nowIso(), id);
		this.append("task", t.toUnit, "task.retry", id, { generation: t.generation + 1, attempts: t.attempts });
	}

	// ---- escalation / approvals (FR5) ----------------------------------------

	escalate(taskId: string, question: string, options: string[]): ApprovalRow {
		const t = this.requireTask(taskId);
		if (t.status === "done" || t.status === "cancelled" || t.status === "escalated")
			throw new Error(`task ${taskId} is ${t.status}, cannot escalate`);
		const holder = this.getUnit(t.toUnit) ?? this.getUnit(t.fromUnit);
		const owner = holder?.owner ?? "unknown";
		const id = this.genId("appr");
		const now = this.clock();
		const row: ApprovalRow = {
			id,
			taskId,
			question,
			options,
			owner,
			status: "open",
			decision: null,
			decidedBy: null,
			expiresAt: new Date(now + this.approvalTtlMs).toISOString(),
			createdAt: new Date(now).toISOString(),
			holderUnitId: holder?.id ?? null,
		};
		this.db.prepare(
			`INSERT INTO approvals (id, task_id, question, options, owner, holder_unit_id, status, decision, decided_by, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?)`,
		).run(id, taskId, question, JSON.stringify(options), owner, row.holderUnitId, row.expiresAt, row.createdAt);
		this.setTaskStatus(taskId, "escalated");
		this.append("approval", t.toUnit, "escalate", id, { taskId, owner, question });
		this.notify(t.fromUnit, "task.escalated", taskId, { approval: id, question, reason: t.reason });
		return row;
	}

	getApproval(id: string): ApprovalRow | null {
		const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
		return r ? rowToApproval(r) : null;
	}

	listOpenApprovals(owner?: string): ApprovalRow[] {
		const rows = owner
			? this.db.prepare("SELECT * FROM approvals WHERE status='open' AND owner=?").all(owner)
			: this.db.prepare("SELECT * FROM approvals WHERE status='open'").all();
		return (rows as Array<Record<string, unknown>>).map(rowToApproval);
	}

	/** Human (or parent owner) resolves an approval. Approving releases the task
	 * for another attempt; denying cancels it and returns its reservation (FR5). */
	resolveApproval(id: string, decision: "approved" | "denied", decidedBy: string, choice?: string): ApprovalRow {
		const a = this.getApproval(id);
		if (!a) throw new Error(`unknown approval ${id}`);
		if (a.status !== "open") throw new Error(`approval ${id} is ${a.status}`);
		// A past-TTL approval is no longer actionable (G8): the sweep re-routes or denies it.
		if (!(Date.parse(a.expiresAt) > this.clock())) throw new Error(`approval ${id} expired`);
		if (choice !== undefined && !a.options.includes(choice)) throw new Error(`choice ${choice} is not one of: ${a.options.join(", ")}`);
		const t = this.getTask(a.taskId);
		const drives = t !== null && t.status === "escalated";
		// Choice 'cancel' on an approved escalation cancels the task like a denial;
		// choice 'extend' raises the task budget (planned before any write: fail closed).
		const cancels = decision === "denied" || choice === "cancel";
		const extension = drives && t && decision === "approved" && choice === "extend" ? this.planExtension(t) : null;
		// Approval decision and the task transition it drives must commit together.
		this.db.exec("BEGIN");
		try {
			this.db.prepare("UPDATE approvals SET status=?, decision=?, decided_by=? WHERE id=?")
				.run(decision, choice ?? decision, decidedBy, id);
			if (drives && t) {
				if (!cancels) {
					if (extension) {
						this.db.prepare("UPDATE tasks SET budget=?, updated_at=? WHERE id=?").run(JSON.stringify(extension.budget), this.nowIso(), t.id);
						this.setBudget(t.fromUnit, extension.parentUsed, extension.parentReserved);
					}
					this.db.prepare("UPDATE tasks SET status='pending', generation=generation+1, updated_at=? WHERE id=?").run(this.nowIso(), t.id);
				} else {
					this.db.prepare("UPDATE tasks SET status='cancelled', reason=?, updated_at=? WHERE id=?")
						.run(`${decision === "denied" ? "denied" : "cancelled"} by ${decidedBy}`, this.nowIso(), t.id);
					this.releaseToParent(t);
				}
			}
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
		this.append("approval", decidedBy, `approval.${decision}`, id, { taskId: a.taskId, choice: choice ?? decision });
		if (drives && t) {
			if (!cancels) this.append("task", decidedBy, "task.approved", t.id, { approval: id, generation: t.generation + 1, ...(extension ? { extendedBudget: extension.budget } : {}) });
			else {
				const why = `${decision === "denied" ? "denied" : "cancelled"} by ${decidedBy}`;
				this.append("task", decidedBy, "task.denied", t.id, { approval: id, reason: why });
				this.notify(t.fromUnit, "task.rejected", t.id, { reason: why, approval: id, cancelled: true });
			}
		}
		return this.getApproval(id) as ApprovalRow;
	}

	/**
	 * Plan an 'extend' (FR6): double the task budget on each dimension it has exhausted
	 * (base = max(used, budget), so zero limits still grow) and reserve the delta against
	 * the delegating unit. Throws, writing nothing, if there is nothing to extend, the
	 * executing unit's own ceiling is exhausted, or the delta exceeds the parent's remaining budget.
	 */
	private planExtension(t: TaskRow): { budget: Budget; parentUsed: Budget; parentReserved: Budget } {
		const dims = exhausted(t.used, t.budget);
		if (dims.length === 0) throw new Error(`cannot extend task ${t.id}: no exhausted budget dimension`);
		const unit = this.getUnit(t.toUnit);
		if (unit && exhausted(unit.used, unit.budget).length > 0)
			throw new Error(`cannot extend task ${t.id}: unit ${t.toUnit} ceiling is exhausted`);
		const parent = this.getUnit(t.fromUnit);
		if (!parent) throw new Error(`cannot extend task ${t.id}: delegating unit ${t.fromUnit} not found`);
		const budget: Budget = { ...t.budget };
		const delta: Budget = { tokens: 0, costUsd: 0, wallClockSec: 0 };
		for (const k of dims) {
			budget[k] = Math.max(t.used[k], t.budget[k]) * 2;
			delta[k] = budget[k] - t.budget[k];
		}
		if (!fits(delta, remaining(parent.budget, parent.used, parent.reserved)))
			throw new Error(`cannot extend task ${t.id}: extension exceeds remaining budget of ${t.fromUnit}`);
		return { budget, parentUsed: parent.used, parentReserved: add(parent.reserved, delta) };
	}

	/** Cancel a task and return its reservation to the parent (root-expiry / timeout path). */
	private cancelTask(t: TaskRow, reason: string, decidedBy: string, approvalId: string): void {
		this.db.exec("BEGIN");
		try {
			this.db.prepare("UPDATE tasks SET status='cancelled', reason=?, updated_at=? WHERE id=?")
				.run(reason, this.nowIso(), t.id);
			this.releaseToParent(t);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
		this.append("task", decidedBy, "task.denied", t.id, { approval: approvalId, reason });
		this.notify(t.fromUnit, "task.rejected", t.id, { reason, approval: approvalId, cancelled: true });
	}

	/**
	 * Expire approvals past their TTL (SPEC FR5/FR8). An expired approval is re-routed
	 * to the parent unit's owner; at the root it becomes `denied`.
	 * Returns the number of approvals transitioned.
	 */
	expireApprovals(): number {
		const now = this.clock();
		const open = this.db.prepare("SELECT * FROM approvals WHERE status='open'").all() as Array<Record<string, unknown>>;
		let n = 0;
		for (const r of open) {
			const a = rowToApproval(r);
			// Instant compare; an unparseable expiry counts as due (fail closed).
			if (Date.parse(a.expiresAt) > now) continue;
			const task = this.getTask(a.taskId);
			// Climb from the unit that currently holds the approval (by unit id, not owner
			// string: owners repeat up the tree), so each expiry moves exactly one level up.
			const holderId = a.holderUnitId ?? (task ? this.unitByOwnerNear(task.toUnit, a.owner)?.id ?? null : null);
			const holder = holderId ? this.getUnit(holderId) : null;
			const parent = holder?.parent ? this.getUnit(holder.parent) : null;
			if (parent) {
				// re-route up one level with a fresh TTL
				const reset = new Date(now + this.approvalTtlMs).toISOString();
				this.db.prepare("UPDATE approvals SET owner=?, holder_unit_id=?, expires_at=? WHERE id=?").run(parent.owner, parent.id, reset, a.id);
				this.append("approval", "control", "approval.reroute", a.id, { from: a.owner, to: parent.owner, holder: parent.id });
			} else {
				this.db.prepare("UPDATE approvals SET status='expired', decision='denied' WHERE id=?").run(a.id);
				this.append("approval", "control", "approval.expire", a.id, { taskId: a.taskId });
				if (task && task.status === "escalated") this.cancelTask(task, "denied by timeout", "control", a.id);
			}
			n++;
		}
		return n;
	}

	// ---- lifecycle + evals (FR8 / G9) ---------------------------------------

	/** Record an eval run for a unit (used to compute the pass rate for deprecation). */
	recordEval(unitId: string, suite: string, passed: number, total: number): EvalRow {
		const row: EvalRow = {
			id: this.genId("eval"),
			unitId,
			suite,
			passed,
			total,
			at: this.nowIso(),
		};
		this.db
			.prepare("INSERT INTO evals (id, unit_id, suite, passed, total, at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(row.id, row.unitId, row.suite, row.passed, row.total, row.at);
		this.append("eval", "control", "eval.record", unitId, { suite, passed, total });
		return row;
	}

	/** The unit's latest eval pass rate (0..1), or null when it has no eval runs. */
	latestEvalRate(unitId: string): number | null {
		const r = this.db
			.prepare("SELECT passed, total FROM evals WHERE unit_id=? ORDER BY at DESC, rowid DESC LIMIT 1")
			.get(unitId) as { passed: number; total: number } | undefined;
		if (!r || r.total <= 0) return null;
		return r.passed / r.total;
	}

	/**
	 * Sweep all active units and apply lifecycle transitions (SPEC FR8):
	 *   - expires_at in the past            → suspended
	 *   - idle longer than retireIdleMs      → retired
	 *   - latest eval pass rate < min_eval   → deprecated
	 * Only active units transition; a unit matching several rules takes the first
	 * that applies in the order above. Returns the transitions performed.
	 */
	sweepLifecycle(): LifecycleTransition[] {
		const now = this.clock();
		const out: LifecycleTransition[] = [];
		for (const unit of this.listUnits()) {
			if (unit.status !== "active") continue;
			let to: UnitStatus | null = null;
			let reason: LifecycleTransition["reason"] | null = null;
			// Compare instants, not strings (offsets / fractional digits differ); an unparseable expiry fails closed.
			const expiresMs = unit.expiresAt === null ? null : Date.parse(unit.expiresAt);
			if (expiresMs !== null && !(expiresMs > now)) {
				to = "suspended";
				reason = "expired";
			} else {
				const since = unit.lastActive ?? unit.createdAt;
				// A unit with in-flight work is never retired, however long since its last touch.
				const busy = this.db.prepare("SELECT 1 FROM tasks WHERE to_unit = ? AND status IN ('pending','running','escalated') LIMIT 1").get(unit.id) !== undefined;
				if (since !== null && now - Date.parse(since) > this.retireIdleMs && !busy) {
					to = "retired";
					reason = "idle";
				} else if (unit.minEval !== null) {
					const rate = this.latestEvalRate(unit.id);
					if (rate !== null && rate < unit.minEval) {
						to = "deprecated";
						reason = "low_eval";
					}
				}
			}
			if (to !== null && reason !== null) {
				this.setUnitStatus(unit.id, to);
				this.append("unit", "control", "unit.lifecycle", unit.id, { from: unit.status, to, reason });
				const data = { from: unit.status, to, reason, owner: unit.owner };
				this.notify(unit.id, "unit.lifecycle", unit.id, data);
				out.push({ unitId: unit.id, from: unit.status, to, reason });
			}
		}
		return out;
	}

	// ---- budget (FR6) --------------------------------------------------------

	/**
	 * Meter real usage against the executing unit, its task and every ancestor (FR6).
	 * The usage is added to the executing unit's ceiling and to the `used` of the task and
	 * every still-open ancestor task, so completion rolls it up each level exactly once.
	 * An ancestor unit's ceiling is breached when its used + reserved, plus whatever the
	 * in-flight task below it has consumed beyond its reservation, exceeds its budget.
	 */
	meter(taskId: string, usage: Budget): MeterResult {
		const t = this.requireTask(taskId);
		if (t.status === "done" || t.status === "cancelled") throw new Error(`task ${taskId} is ${t.status}, cannot meter`);
		const unit = this.getUnit(t.toUnit);
		if (!unit) throw new Error(`unknown unit ${t.toUnit}`);
		const unitUsed = add(unit.used, usage);
		const taskUsed = add(t.used, usage);
		// Over the task's reserved budget, or over the unit's own ceiling (FR6).
		const over = new Set<keyof Budget>([...exhausted(taskUsed, t.budget), ...exhausted(unitUsed, unit.budget)]);
		// Ancestors: walk the delegation chain, charging each open ancestor task and checking its delegator's ceiling.
		const ancestors: Array<{ task: TaskRow; used: Budget }> = [];
		let cur: TaskRow | null = t;
		const seen = new Set<string>([t.id]);
		while (cur) {
			const delegator = this.getUnit(cur.fromUnit);
			const inFlight = cur.id === t.id ? taskUsed : add(cur.used, usage);
			if (delegator) {
				const overrun = clampZero(sub(inFlight, cur.budget));
				const projected = add(add(delegator.used, delegator.reserved), overrun);
				for (const k of ["tokens", "costUsd", "wallClockSec"] as const) if (projected[k] > delegator.budget[k]) over.add(k);
			}
			if (cur.parentTask === null || seen.has(cur.parentTask)) break;
			seen.add(cur.parentTask);
			const parent = this.getTask(cur.parentTask);
			if (!parent) break;
			// A settled ancestor already rolled its usage up; charging it again would double count.
			if (parent.status !== "done" && parent.status !== "cancelled") ancestors.push({ task: parent, used: add(parent.used, usage) });
			cur = parent;
		}
		const overBudget = [...over];
		// Usage update, audit row and escalation commit or roll back together.
		this.db.exec("BEGIN");
		try {
			this.setBudget(t.toUnit, unitUsed, unit.reserved);
			this.db.prepare("UPDATE tasks SET used=?, updated_at=? WHERE id=?").run(JSON.stringify(taskUsed), this.nowIso(), taskId);
			for (const a of ancestors) {
				this.db.prepare("UPDATE tasks SET used=?, updated_at=? WHERE id=?").run(JSON.stringify(a.used), this.nowIso(), a.task.id);
			}
			this.touchUnit(t.toUnit);
			this.append("budget", t.toUnit, "meter", taskId, { usage });
			let escalation: ApprovalRow | null = null;
			if (overBudget.length > 0 && t.status !== "escalated" && !this.hasOpenApproval(taskId)) {
				// 'extend' only helps when the task's OWN limit is exhausted; an ancestor-ceiling breach can only be cancelled.
				const options = exhausted(taskUsed, t.budget).length > 0 ? ["extend", "cancel"] : ["cancel"];
				escalation = this.escalate(taskId, `budget exhausted on ${overBudget.join(",")}`, options);
			}
			this.db.exec("COMMIT");
			return { used: unitUsed, overBudget, escalation };
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	private hasOpenApproval(taskId: string): boolean {
		return this.db.prepare("SELECT 1 FROM approvals WHERE task_id = ? AND status = 'open' LIMIT 1").get(taskId) !== undefined;
	}

	/** Remaining budget available to a unit for new work. */
	remainingBudget(id: string): Budget {
		const u = this.getUnit(id);
		if (!u) throw new Error(`unknown unit ${id}`);
		return remaining(u.budget, u.used, u.reserved);
	}

	private releaseToParent(t: TaskRow): void {
		const parent = this.getUnit(t.fromUnit);
		if (!parent) return;
		// Roll THIS task's metered usage into the parent, and release the whole reservation.
		// Per-task usage (not the child unit's lifetime total) so multiple tasks to the same
		// child never multiply-count (FR6).
		const task = this.getTask(t.id) ?? t;
		// Roll the task's FULL metered usage into the parent (an overrun stays charged, so the
		// tree ceiling is conserved) and release only the reservation (FR6).
		const taskUsed = task.used;
		const reserved = clampZero(sub(parent.reserved, t.budget));
		this.setBudget(t.fromUnit, add(parent.used, taskUsed), reserved);
	}

	private setBudget(id: string, used: Budget, reserved: Budget): void {
		this.db.prepare("UPDATE units SET used=?, reserved=? WHERE id=?").run(JSON.stringify(used), JSON.stringify(reserved), id);
	}

	// ---- artifacts -----------------------------------------------------------

	storeArtifact(artifact: unknown): string {
		const content = canonicalJson(artifact);
		const hash = createHash("sha256").update(content).digest("hex");
		this.db.prepare("INSERT OR IGNORE INTO artifacts (hash, content, created_at) VALUES (?, ?, ?)").run(hash, content, this.nowIso());
		return hash;
	}

	getArtifact(hash: string): JsonValue | undefined {
		const r = this.db.prepare("SELECT content FROM artifacts WHERE hash = ?").get(hash) as { content: string } | undefined;
		return r ? fromJson<JsonValue>(r.content, "artifact") : undefined;
	}

	// ---- audit (FR7) ---------------------------------------------------------

	/** Append a PDP decision for `unitId` to the audit chain. */
	recordDecision(unitId: string, taskId: string | null, req: ToolRequest, decision: Decision): ChainedEntry {
		this.touchUnit(unitId);
		return this.append("policy", unitId, decision.allow ? "tool.allow" : "tool.deny", req.toolName, {
			paths: req.paths,
			reason: decision.allow ? null : decision.reason,
			taskId,
		});
	}

	append(kind: string, actor: string, action: string, subject: string, data: unknown): ChainedEntry {
		const prev = this.lastAudit();
		const entry = chain(prev, { at: this.nowIso(), actor: `${kind}:${actor}`, action, subject, data });
		this.db.prepare("INSERT INTO audit (seq, at, actor, action, subject, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.run(entry.seq, entry.at, entry.actor, entry.action, entry.subject, canonicalJson(entry.data), entry.prevHash, entry.hash);
		return entry;
	}

	private lastAudit(): ChainedEntry | null {
		const r = this.db.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT 1").get() as Record<string, unknown> | undefined;
		return r ? rowToAudit(r) : null;
	}

	auditEntries(): ChainedEntry[] {
		return (this.db.prepare("SELECT * FROM audit ORDER BY seq ASC").all() as Array<Record<string, unknown>>).map(rowToAudit);
	}

	verifyAudit(): ReturnType<typeof verify> {
		return verify(this.auditEntries());
	}

	/** Export a tamper-evidence anchor over the current chain head (SPEC G6). */
	exportAnchor(): AuditAnchor {
		return buildAnchor(this.auditEntries(), this.nowIso());
	}

	/** Verify the live chain is a faithful continuation of a previously-exported anchor. */
	verifyAnchor(anchor: AuditAnchor): AnchorCheck {
		return verifyAgainstAnchor(this.auditEntries(), anchor);
	}

	// ---- helpers -------------------------------------------------------------

	/** Find the unit along the executing unit's ancestor chain whose owner matches, defaulting to the executing unit. */
	private unitByOwnerNear(execUnitId: string, owner: string): UnitRow | null {
		let cur: string | null = execUnitId;
		const seen = new Set<string>();
		while (cur !== null && !seen.has(cur)) {
			seen.add(cur);
			const u = this.getUnit(cur);
			if (!u) return null;
			if (u.owner === owner) return u;
			cur = u.parent;
		}
		return this.getUnit(execUnitId);
	}

	// ---- notifications (FR4/FR8) ---------------------------------------------

	/**
	 * Queue an audited notification for a unit (parent on child done/escalated/rejected, unit on lifecycle change).
	 * The row also carries the addressed unit's OWNER, so a human owner can read it from the owner inbox
	 * even when the unit has no live session (retired/suspended unit, parent without a worker) (FR8).
	 */
	notify(unitId: string, kind: NotificationKind, subject: string, data: JsonValue): NotificationRow {
		const owner = this.getUnit(unitId)?.owner ?? null;
		const row: NotificationRow = { id: this.genId("note"), unitId, owner, kind, subject, data, createdAt: this.nowIso(), ackedAt: null };
		this.db
			.prepare("INSERT INTO notifications (id, unit_id, owner, kind, subject, data, created_at, acked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
			.run(row.id, unitId, owner, kind, subject, canonicalJson(data), row.createdAt);
		this.append("notify", unitId, `notify.${kind}`, subject, { id: row.id });
		return row;
	}

	/** Unacknowledged notifications for a unit, oldest first. */
	listNotifications(unitId: string): NotificationRow[] {
		const rows = this.db
			.prepare("SELECT * FROM notifications WHERE unit_id = ? AND acked_at IS NULL ORDER BY created_at ASC, rowid ASC")
			.all(unitId) as Array<Record<string, unknown>>;
		return rows.map(rowToNotification);
	}

	/** Unacknowledged notifications addressed to an owner's units (owner inbox), oldest first. Omit `owner` for all (admin). */
	listOwnerNotifications(owner?: string): NotificationRow[] {
		const rows = (owner === undefined
			? this.db.prepare("SELECT * FROM notifications WHERE acked_at IS NULL ORDER BY created_at ASC, rowid ASC").all()
			: this.db.prepare("SELECT * FROM notifications WHERE owner = ? AND acked_at IS NULL ORDER BY created_at ASC, rowid ASC").all(owner)) as Array<Record<string, unknown>>;
		return rows.map(rowToNotification);
	}

	/** Acknowledge one of the unit's own notifications. Returns false when it is unknown, foreign or already acked. */
	ackNotification(unitId: string, id: string): boolean {
		const info = this.db.prepare("UPDATE notifications SET acked_at = ? WHERE id = ? AND unit_id = ? AND acked_at IS NULL").run(this.nowIso(), id, unitId);
		if (info.changes === 0) return false;
		this.append("notify", unitId, "notify.ack", id, {});
		return true;
	}

	/** Acknowledge a notification from the owner inbox. `owner` undefined = admin (any). False when unknown, foreign or already acked. */
	ackOwnerNotification(owner: string | undefined, id: string): boolean {
		const info =
			owner === undefined
				? this.db.prepare("UPDATE notifications SET acked_at = ? WHERE id = ? AND acked_at IS NULL").run(this.nowIso(), id)
				: this.db.prepare("UPDATE notifications SET acked_at = ? WHERE id = ? AND owner = ? AND acked_at IS NULL").run(this.nowIso(), id, owner);
		if (info.changes === 0) return false;
		this.append("notify", owner ?? "admin", "notify.ack", id, {});
		return true;
	}

	private requireTask(id: string): TaskRow {
		const t = this.getTask(id);
		if (!t) throw new Error(`unknown task ${id}`);
		return t;
	}

	private setTaskStatus(id: string, status: TaskStatus): void {
		this.db.prepare("UPDATE tasks SET status=?, updated_at=? WHERE id=?").run(status, this.nowIso(), id);
	}

	private touchUnit(id: string): void {
		this.db.prepare("UPDATE units SET last_active=? WHERE id=?").run(this.nowIso(), id);
	}
}

function clampZero(b: Budget): Budget {
	return { tokens: Math.max(0, b.tokens), costUsd: Math.max(0, b.costUsd), wallClockSec: Math.max(0, b.wallClockSec) };
}

/** Parse JSON we wrote ourselves; a parse failure means DB corruption, so fail loudly. */
function fromJson<T>(s: string, ctx: string): T {
	try {
		return JSON.parse(s) as T;
	} catch (e) {
		throw new Error(`corrupt ${ctx} in control.db: ${(e as Error).message}`);
	}
}

// ---- row mappers (DB text columns → typed) ---------------------------------

function rowToUnit(r: Record<string, unknown>): UnitRow {
	return {
		id: r.id as string,
		path: r.path as string,
		parent: (r.parent as string | null) ?? null,
		owner: r.owner as string,
		grants: parseGrants(fromJson<string[]>(r.grants as string, "unit.grants")),
		budget: fromJson<Budget>(r.budget as string, "unit.budget"),
		limits: fromJson<Manifest["limits"]>(r.limits as string, "unit.limits"),
		expiresAt: (r.expires_at as string | null) ?? null,
		minEval: (r.min_eval as number | null) ?? null,
		status: r.status as UnitStatus,
		used: fromJson<Budget>(r.used as string, "unit.used"),
		reserved: fromJson<Budget>(r.reserved as string, "unit.reserved"),
		lastActive: (r.last_active as string | null) ?? null,
		createdAt: (r.created_at as string | null) ?? null,
	};
}

function rowToTask(r: Record<string, unknown>): TaskRow {
	const grantsRaw = r.grants as string | null;
	return {
		id: r.id as string,
		fromUnit: r.from_unit as string,
		toUnit: r.to_unit as string,
		goal: r.goal as string,
		contract: fromJson<Contract>(r.contract as string, "task.contract"),
		grants: grantsRaw ? parseGrants(fromJson<string[]>(grantsRaw, "task.grants")) : null,
		budget: fromJson<Budget>(r.budget as string, "task.budget"),
		used: r.used != null ? fromJson<Budget>(r.used as string, "task.used") : ZERO,
		deadline: (r.deadline as string | null) ?? null,
		status: r.status as TaskStatus,
		parentTask: (r.parent_task as string | null) ?? null,
		attempts: r.attempts as number,
		generation: (r.generation as number | undefined) ?? 0,
		reason: (r.reason as string | null) ?? null,
		artifactHash: (r.artifact_hash as string | null) ?? null,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
	};
}

function rowToApproval(r: Record<string, unknown>): ApprovalRow {
	return {
		id: r.id as string,
		taskId: r.task_id as string,
		question: r.question as string,
		options: fromJson<string[]>(r.options as string, "approval.options"),
		owner: r.owner as string,
		status: r.status as ApprovalStatus,
		decision: (r.decision as string | null) ?? null,
		decidedBy: (r.decided_by as string | null) ?? null,
		expiresAt: r.expires_at as string,
		createdAt: r.created_at as string,
		holderUnitId: (r.holder_unit_id as string | null) ?? null,
	};
}

function rowToNotification(r: Record<string, unknown>): NotificationRow {
	return {
		id: r.id as string,
		unitId: r.unit_id as string,
		owner: (r.owner as string | null) ?? null,
		kind: r.kind as NotificationKind,
		subject: r.subject as string,
		data: fromJson<JsonValue>(r.data as string, "notification.data"),
		createdAt: r.created_at as string,
		ackedAt: (r.acked_at as string | null) ?? null,
	};
}

function rowToAudit(r: Record<string, unknown>): ChainedEntry {
	return {
		seq: r.seq as number,
		at: r.at as string,
		actor: r.actor as string,
		action: r.action as string,
		subject: r.subject as string,
		data: fromJson<unknown>(r.data as string, "audit.data"),
		prevHash: r.prev_hash as string,
		hash: r.hash as string,
	};
}

export { GENESIS };
