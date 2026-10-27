/**
 * Shared bootstrap for the org extensions. Opens the ControlClient lazily in
 * session_start (never in the factory — ADR-0001) and exposes it to the
 * individual extension installers. Inert when not running inside the org
 * (resolveUnitConfig returns enabled:false).
 */

import { LocalControlClient, type ControlClient } from "@agentic-pi/control-plane";
import { resolveUnitConfig } from "@agentic-pi/control-plane";
import type { ExtensionAPI } from "./pi-api.ts";

export interface OrgRuntime {
	enabled: boolean;
	unitId: string;
	taskId: string | null;
	/** Non-null only after session_start when enabled. */
	client: ControlClient | null;
}

export interface BootstrapOptions {
	env?: Record<string, string | undefined>;
	/** Factory for the client (tests inject a fake). Defaults to LocalControlClient.open. */
	openClient?: (args: { unitId: string; taskId: string | null; dbPath: string }) => ControlClient;
}

/**
 * Create the shared runtime and register session lifecycle handlers that open
 * and close the control client. Returns the runtime object, which the extension
 * installers read after session_start.
 */
export function bootstrap(pi: ExtensionAPI, opts: BootstrapOptions = {}): OrgRuntime {
	const env = opts.env ?? process.env;
	const resolved = resolveUnitConfig(env);
	if (!resolved.ok) {
		// Misconfiguration is fatal: fail closed by throwing in the factory's caller.
		throw new Error(`org extensions: ${resolved.reason}`);
	}
	const { enabled, unitId, taskId, dbPath } = resolved.config;
	const runtime: OrgRuntime = { enabled, unitId, taskId, client: null };
	if (!enabled) return runtime;

	const open = opts.openClient ?? LocalControlClient.open;
	pi.on("session_start", () => {
		if (runtime.client) return; // idempotent
		runtime.client = open({ unitId, taskId, dbPath });
	});
	pi.on("session_shutdown", () => {
		runtime.client?.close();
		runtime.client = null;
	});
	return runtime;
}
