/**
 * Single-owner lock for one task's pi-durable storage.
 *
 * pi-durable has no cross-process storage locking ("one process owns a storage
 * at a time"), so the worker must provide it. The lock is a file created with
 * O_EXCL holding the owner's pid and a random nonce. A lock whose pid is dead
 * is stale (the owner crashed) and is taken over; a live pid refuses us.
 *
 * Stale takeover renames the stale file away first (atomic) and re-verifies
 * what it moved before deleting it, so two racing takers cannot both win: the
 * loser's O_EXCL create fails. Pid reuse can make a dead owner look alive
 * (fail closed: refuse); it can never make a live owner look dead.
 */

import { randomBytes } from "node:crypto";
import { closeSync, constants, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export class LockHeldError extends Error {
	readonly ownerPid: number;
	constructor(path: string, ownerPid: number) {
		super(`durable storage lock ${path} is held by live pid ${ownerPid}`);
		this.name = "LockHeldError";
		this.ownerPid = ownerPid;
	}
}

export interface TaskLock {
	readonly path: string;
	/** Idempotent. Removes the lock file only if it is still ours. */
	release(): void;
}

export interface LockOptions {
	pid?: number;
	/** Liveness probe; default `process.kill(pid, 0)`. */
	isAlive?: (pid: number) => boolean;
}

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A task id becomes a file name: reject anything that could escape the directory. */
export function assertSafeTaskId(taskId: string): void {
	if (!SAFE_TASK_ID.test(taskId) || taskId.includes("..")) throw new Error(`unsafe task id for a file name: ${JSON.stringify(taskId)}`);
}

export const lockPathFor = (dir: string, taskId: string): string => join(dir, `${taskId}.lock`);
export const dbPathFor = (dir: string, taskId: string): string => join(dir, `${taskId}.db`);

const defaultAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM: exists but not ours: alive. ESRCH: gone.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

interface LockBody {
	pid: number;
	nonce: string;
}

function readBody(path: string): LockBody | null {
	try {
		const v = JSON.parse(readFileSync(path, "utf8")) as Partial<LockBody>;
		return typeof v.pid === "number" && Number.isInteger(v.pid) && v.pid > 0 && typeof v.nonce === "string" ? { pid: v.pid, nonce: v.nonce } : null;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		return null; // unreadable / torn body: handled as "unknown owner" by the caller
	}
}

function tryCreate(path: string, body: LockBody): boolean {
	let fd: number;
	try {
		fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw e;
	}
	try {
		writeSync(fd, JSON.stringify(body));
	} finally {
		closeSync(fd);
	}
	return true;
}

export function acquireTaskLock(dir: string, taskId: string, opts: LockOptions = {}): TaskLock {
	assertSafeTaskId(taskId);
	const path = lockPathFor(dir, taskId);
	const pid = opts.pid ?? process.pid;
	const alive = opts.isAlive ?? defaultAlive;
	const body: LockBody = { pid, nonce: randomBytes(8).toString("hex") };

	for (let attempt = 0; attempt < 5; attempt++) {
		if (tryCreate(path, body)) {
			let released = false;
			return {
				path,
				release() {
					if (released) return;
					released = true;
					const cur = readBody(path);
					if (cur && cur.pid === body.pid && cur.nonce === body.nonce) {
						try {
							unlinkSync(path);
						} catch {
							// already gone
						}
					}
				},
			};
		}
		const owner = readBody(path);
		// An unreadable body may be a creator between O_EXCL and write: treat as held (fail closed).
		if (!owner) {
			if (!pathExists(path)) continue;
			throw new LockHeldError(path, 0);
		}
		if (alive(owner.pid)) throw new LockHeldError(path, owner.pid);
		// Stale: move it aside atomically, then confirm we moved the stale owner's file.
		const aside = `${path}.stale-${pid}-${body.nonce}`;
		try {
			renameSync(path, aside);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw e;
		}
		const moved = readBody(aside);
		if (moved && moved.pid === owner.pid && moved.nonce === owner.nonce) {
			unlinkSync(aside);
			continue;
		}
		// We moved a fresh lock another taker just created: put it back if the slot is free, else refuse.
		try {
			linkSync(aside, path);
		} finally {
			unlinkSync(aside);
		}
		throw new LockHeldError(path, moved?.pid ?? 0);
	}
	throw new Error(`could not acquire durable storage lock ${path}`);
}

function pathExists(path: string): boolean {
	try {
		readFileSync(path);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code !== "ENOENT";
	}
}
