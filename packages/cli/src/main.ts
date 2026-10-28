#!/usr/bin/env node
/**
 * `org` — the agentic-pi operator CLI entrypoint (ADR-0007).
 *
 * Configuration is environment-only so it drops into the control host cleanly:
 *   ORG_CONTROL_SOCKET    Unix socket the control plane listens on (required)
 *   ORG_ADMIN_TOKEN_FILE  file holding the operator admin token      (required)
 *   ORG_ADMIN_TOKEN       the admin token directly (overrides the file)
 *
 * Hosts the `approvals`, `notifications` and `units` commands; future operator verbs (tasks,
 * audit) register here too.
 */

import { readFileSync } from "node:fs";

import { AdminClient, ControlStore, syncUnits } from "pi-agentic-control-plane";
import { runApprovals } from "./approvals.ts";
import { runNotifications } from "./notifications.ts";
import { type UnitSyncTarget, runUnits } from "./units.ts";

interface CliConfig {
	socketPath: string;
	token: string;
}

function configFromEnv(env: Record<string, string | undefined>): CliConfig {
	const socketPath = env.ORG_CONTROL_SOCKET;
	if (!socketPath) throw new Error("ORG_CONTROL_SOCKET is required");
	const direct = env.ORG_ADMIN_TOKEN;
	const tokenFile = env.ORG_ADMIN_TOKEN_FILE;
	const token = direct ?? (tokenFile ? readFileSync(tokenFile, "utf8").trim() : undefined);
	if (!token) throw new Error("ORG_ADMIN_TOKEN or ORG_ADMIN_TOKEN_FILE is required");
	return { socketPath, token };
}

/** Live daemon over the admin socket, or (`--db`) control.db opened directly while the daemon is stopped. */
async function openUnitTarget(db: string | undefined, env: Record<string, string | undefined>): Promise<{ target: UnitSyncTarget; close(): void }> {
	if (db !== undefined) {
		// ControlStore creates control.db (and its schema) when absent: bootstrap before the daemon's first start.
		const store = new ControlStore(db, {});
		return { target: { syncUnits: (manifests) => Promise.resolve(syncUnits(store, manifests, "offline-admin")) }, close: () => store.close() };
	}
	const cfg = configFromEnv(env);
	const client = new AdminClient({ socketPath: cfg.socketPath, token: cfg.token });
	return { target: client, close: () => client.close() };
}

/**
 * Run the CLI with an explicit argv tail (after `org`). Returns the exit code.
 * Pure w.r.t. process: writes through the injected `out` sink and closes the
 * client it opens. Tests call this with a fake env + out.
 */
export async function runCli(
	argv: readonly string[],
	env: Record<string, string | undefined>,
	out: (line: string) => void,
): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "help" || command === "--help" || command === "-h") {
		for (const line of USAGE) out(line);
		return 0;
	}
	if (command === "units") {
		const result = await runUnits(rest, (db) => openUnitTarget(db, env));
		for (const line of result.lines) out(line);
		return result.exitCode;
	}
	if (command !== "approvals" && command !== "notifications") {
		out(command ? `error: unknown command '${command}' (see org --help)` : USAGE_LINE);
		return 2;
	}
	const cfg = configFromEnv(env);
	const client = new AdminClient({ socketPath: cfg.socketPath, token: cfg.token });
	try {
		const result = command === "approvals" ? await runApprovals(client, rest) : await runNotifications(client, rest);
		for (const line of result.lines) out(line);
		return result.exitCode;
	} finally {
		client.close();
	}
}

const USAGE_LINE = "usage: org <approvals|notifications|units> [args]   (org --help for details)";
const USAGE = [
	USAGE_LINE,
	"  org approvals list                      open approvals you may act on",
	"  org approvals approve <id> [choice]     approve (choice must be one of the approval's options)",
	"  org approvals deny <id> [choice]        deny",
	"  org notifications [list]                unacked owner/admin notifications",
	"  org notifications ack <id>              acknowledge a notification",
	"  org units sync <org-root> [--db <path>] register/update units from unit.json manifests",
	"env: ORG_CONTROL_SOCKET + ORG_ADMIN_TOKEN or ORG_ADMIN_TOKEN_FILE (not needed for units sync --db)",
];

async function main(): Promise<void> {
	const code = await runCli(process.argv.slice(2), process.env, (line) => process.stdout.write(`${line}\n`));
	process.exit(code);
}

if (import.meta.main) {
	main().catch((e: unknown) => {
		process.stderr.write(`org: ${(e as Error).message}\n`);
		process.exit(1);
	});
}
