/**
 * Resolve the current unit's identity and control-plane location from the
 * environment. Pure given an env bag so it is unit-testable. No I/O here —
 * opening the store happens lazily in session_start (ADR-0001: never do I/O
 * in an extension factory).
 */

export interface UnitConfig {
	/** This worker's unit id (the unit it acts as). */
	unitId: string;
	/** Absolute path to control.db. */
	dbPath: string;
	/** Current task id this worker is executing, if any. */
	taskId: string | null;
	/** Whether the org extensions should enforce (false in a plain dev session). */
	enabled: boolean;
	/** Unix socket to the control plane, if the worker should use a socket client. */
	socketPath: string | null;
	/** Dev bearer token for the hello handshake. */
	token: string | null;
}

export interface ResolveResult {
	ok: true;
	config: UnitConfig;
}

export interface ResolveError {
	ok: false;
	reason: string;
}

export const ENV_UNIT = "ORG_UNIT_ID";
export const ENV_DB = "ORG_CONTROL_DB";
export const ENV_TASK = "ORG_TASK_ID";
/** Unix socket to the control plane (socket-backed client). Optional: absent → in-process store. */
export const ENV_SOCKET = "ORG_CONTROL_SOCKET";
/** Dev bearer token presented at hello when uid auth is unavailable. */
export const ENV_TOKEN = "ORG_UNIT_TOKEN";

export function resolveUnitConfig(env: Record<string, string | undefined>): ResolveResult | ResolveError {
	const unitId = env[ENV_UNIT];
	const dbPath = env[ENV_DB];
	if (!unitId && !dbPath) {
		// Not running inside the org: extensions load but stay inert.
		return {
			ok: true,
			config: { unitId: "", dbPath: "", taskId: null, enabled: false, socketPath: null, token: null },
		};
	}
	if (!unitId) return { ok: false, reason: `${ENV_UNIT} is required when ${ENV_DB} is set` };
	if (!dbPath) return { ok: false, reason: `${ENV_DB} is required when ${ENV_UNIT} is set` };
	const taskId = env[ENV_TASK];
	const socketPath = env[ENV_SOCKET];
	const token = env[ENV_TOKEN];
	return {
		ok: true,
		config: {
			unitId,
			dbPath,
			taskId: taskId && taskId.length > 0 ? taskId : null,
			enabled: true,
			socketPath: socketPath && socketPath.length > 0 ? socketPath : null,
			token: token && token.length > 0 ? token : null,
		},
	};
}
