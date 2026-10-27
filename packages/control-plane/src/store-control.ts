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
import { type AuditAnchor, type AnchorCheck, type ChainedEntry, GENESIS, buildAnchor, canonicalJson, chain, verify, verifyAgainstAnchor } from "@agentic-pi/core";
import { add, sub, exhausted, fits, remaining } from "@agentic-pi/core";
import { ZERO } from "@agentic-pi/core";
import { type Contract, type GateResult, type JudgeFn, runGates } from "@agentic-pi/core";
import { type Grant, effectiveGrants, formatGrant, parseGrants } from "@agentic-pi/core";
import type { Budget, Manifest } from "@agentic-pi/core";
import { type DelegationCheck, type OrgSnapshot, type UnitStatus, checkDelegation } from "@agentic-pi/core";

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
	deadline: string | null;
	status: TaskStatus;
	parentTask: string | null;
	attempts: number;
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
}

export interface UnitRow extends Manifest {
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
  deadline TEXT,
  status TEXT NOT NULL,
  parent_task TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
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
`;

const DAY_MS = 24 * 60 * 60 * 1000;

export class ControlStore {
	private readonly db: DatabaseSync;
	private readonly clock: () => number;
	private readonly genId: (prefix: string) => string;
	private readonly approvalTtlMs: number;
	private readonly retireIdleMs: number;
	/** Filesystem path to control.db (so the dispatcher can wire ORG_CONTROL_DB). */
	readonly dbPath: string;

	constructor(path: string, opts: ControlStoreOptions = {}) {
		this.dbPath = path;
		this.clock = opts.clock ?? Date.now;
		this.genId = opts.genId ?? ((p) => `${p}_${createHash("sha256").update(`${Math.random()}${this.clock()}`).digest("hex").slice(0, 16)}`);
		this.approvalTtlMs = opts.approvalTtlMs ?? DAY_MS;
		this.retireIdleMs = opts.retireIdleMs ?? 90 * DAY_MS;
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		this.db.exec(SCHEMA);
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
	private openChildren(parentTask: string | null): number {
		if (parentTask === null) {
			const r = this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_task IS NULL AND status IN ('pending','running','escalated')").get() as { n: number };
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

		const snapshot: OrgSnapshot = {
			units: this.unitsSnapshot(),
			callerGrants: this.callerGrants(input.fromUnit, parentTask),
			callerUsed: from.used,
			callerReserved: from.reserved,
			taskChainUnits: this.taskChainUnits(input.fromUnit, parentTask),
			openChildren: this.openChildren(parentTask),
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
		const t = this.getTask(id);
		if (!t) return { ok: false, status: "error", reason: `unknown task ${id}` };
		if (t.status === "done") return { ok: false, status: "error", reason: `task ${id} already done` };
		if (t.status === "escalated") return { ok: false, status: "error", reason: `task ${id} is escalated` };

		const artifactHash = this.storeArtifact(artifact);
		const gate = await runGates(t.contract, artifact, judge);
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
			return { ok: true, status: "done", gate, artifactHash };
		}

		const reason = `${gate.stage}: ${gate.reasons.join("; ")}`;
		const limit = this.getUnit(t.fromUnit)?.limits.maxAttempts ?? 2;
		if (attempts >= limit) {
			this.db.prepare("UPDATE tasks SET status='escalated', attempts=?, reason=?, artifact_hash=?, updated_at=? WHERE id=?")
				.run(attempts, reason, artifactHash, this.nowIso(), id);
			this.append("task", t.toUnit, "complete.escalate", id, { reason, attempts });
			return { ok: false, status: "escalated", gate, attempts, artifactHash };
		}
		this.db.prepare("UPDATE tasks SET status='rejected', attempts=?, reason=?, artifact_hash=?, updated_at=? WHERE id=?")
			.run(attempts, reason, artifactHash, this.nowIso(), id);
		this.append("task", t.toUnit, "complete.reject", id, { reason, attempts });
		return { ok: false, status: "rejected", gate, attempts, artifactHash };
	}

	/** Re-open a rejected task for another attempt (dispatcher retry path). */
	retryTask(id: string): void {
		const t = this.requireTask(id);
		if (t.status !== "rejected") throw new Error(`task ${id} is ${t.status}, not rejected`);
		this.setTaskStatus(id, "pending");
	}

	// ---- escalation / approvals (FR5) ----------------------------------------

	escalate(taskId: string, question: string, options: string[]): ApprovalRow {
		const t = this.requireTask(taskId);
		const owner = this.getUnit(t.toUnit)?.owner ?? this.getUnit(t.fromUnit)?.owner ?? "unknown";
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
		};
		this.db.prepare(
			`INSERT INTO approvals (id, task_id, question, options, owner, status, decision, decided_by, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?)`,
		).run(id, taskId, question, JSON.stringify(options), owner, row.expiresAt, row.createdAt);
		if (t.status !== "escalated") this.setTaskStatus(taskId, "escalated");
		this.append("approval", t.toUnit, "escalate", id, { taskId, owner, question });
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

	/** Human (or parent owner) resolves an approval. */
	resolveApproval(id: string, decision: "approved" | "denied", decidedBy: string, choice?: string): ApprovalRow {
		const a = this.getApproval(id);
		if (!a) throw new Error(`unknown approval ${id}`);
		if (a.status !== "open") throw new Error(`approval ${id} is ${a.status}`);
		this.db.prepare("UPDATE approvals SET status=?, decision=?, decided_by=? WHERE id=?")
			.run(decision, choice ?? decision, decidedBy, id);
		this.append("approval", decidedBy, `approval.${decision}`, id, { taskId: a.taskId, choice: choice ?? decision });
		return this.getApproval(id) as ApprovalRow;
	}

	/**
	 * Expire approvals past their TTL (SPEC FR5/FR8). An expired approval is re-routed
	 * to the parent unit's owner; at the root it becomes `denied`.
	 * Returns the number of approvals transitioned.
	 */
	expireApprovals(): number {
		const now = this.nowIso();
		const due = this.db.prepare("SELECT * FROM approvals WHERE status='open' AND expires_at <= ?").all(now) as Array<Record<string, unknown>>;
		let n = 0;
		for (const r of due) {
			const a = rowToApproval(r);
			const task = this.getTask(a.taskId);
			// Climb from the unit that currently holds the approval, not the executing unit,
			// so each expiry moves exactly one level up the tree (SPEC FR5).
			const holder = task ? this.unitByOwnerNear(task.toUnit, a.owner) : null;
			const parent = holder?.parent ? this.getUnit(holder.parent) : null;
			if (parent) {
				// re-route up one level with a fresh TTL
				const reset = new Date(this.clock() + this.approvalTtlMs).toISOString();
				this.db.prepare("UPDATE approvals SET owner=?, expires_at=? WHERE id=?").run(parent.owner, reset, a.id);
				this.append("approval", "control", "approval.reroute", a.id, { from: a.owner, to: parent.owner });
			} else {
				this.db.prepare("UPDATE approvals SET status='expired', decision='denied' WHERE id=?").run(a.id);
				this.append("approval", "control", "approval.expire", a.id, { taskId: a.taskId });
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
			.prepare("SELECT passed, total FROM evals WHERE unit_id=? ORDER BY at DESC, id DESC LIMIT 1")
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
		const nowIso = new Date(now).toISOString();
		const out: LifecycleTransition[] = [];
		for (const unit of this.listUnits()) {
			if (unit.status !== "active") continue;
			let to: UnitStatus | null = null;
			let reason: LifecycleTransition["reason"] | null = null;
			if (unit.expiresAt !== null && unit.expiresAt <= nowIso) {
				to = "suspended";
				reason = "expired";
			} else {
				const since = unit.lastActive ?? unit.createdAt;
				if (since !== null && now - Date.parse(since) > this.retireIdleMs) {
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
				out.push({ unitId: unit.id, from: unit.status, to, reason });
			}
		}
		return out;
	}

	// ---- budget (FR6) --------------------------------------------------------

	/** Meter real usage against the executing unit and its task. Returns over-budget dims. */
	meter(taskId: string, usage: Budget): MeterResult {
		const t = this.requireTask(taskId);
		const unit = this.getUnit(t.toUnit);
		if (!unit) throw new Error(`unknown unit ${t.toUnit}`);
		const used = add(unit.used, usage);
		this.setBudget(t.toUnit, used, unit.reserved);
		// Over the task's reserved budget, or over the unit's own ceiling.
		const over = new Set<keyof Budget>([...exhausted(used, unit.budget)]);
		this.append("budget", t.toUnit, "meter", taskId, { usage });
		return { used, overBudget: [...over] };
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
		// Release the reservation; roll the child's actual usage up into the parent (FR6).
		const child = this.getUnit(t.toUnit);
		const childUsed = child ? child.used : ZERO;
		const taskUsed = fits(childUsed, t.budget) ? childUsed : t.budget;
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
		deadline: (r.deadline as string | null) ?? null,
		status: r.status as TaskStatus,
		parentTask: (r.parent_task as string | null) ?? null,
		attempts: r.attempts as number,
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
