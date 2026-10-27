#!/usr/bin/env node
/**
 * `org` — the agentic-pi operator CLI entrypoint (ADR-0007).
 *
 * Configuration is environment-only so it drops into the control host cleanly:
 *   ORG_CONTROL_SOCKET    Unix socket the control plane listens on (required)
 *   ORG_ADMIN_TOKEN_FILE  file holding the operator admin token      (required)
 *   ORG_ADMIN_TOKEN       the admin token directly (overrides the file)
 *
 * Currently hosts the `approvals` command; future operator verbs (units, tasks,
 * audit) register here too.
 */

import { readFileSync } from "node:fs";

import { AdminClient } from "@agentic-pi/control-plane";
import { runApprovals } from "./approvals.ts";

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
	if (command !== "approvals") {
		out(command ? `error: unknown command '${command}'` : "usage: org approvals <list|approve|deny> [args]");
		return 2;
	}
	const cfg = configFromEnv(env);
	const client = new AdminClient({ socketPath: cfg.socketPath, token: cfg.token });
	try {
		const result = await runApprovals(client, rest);
		for (const line of result.lines) out(line);
		return result.exitCode;
	} finally {
		client.close();
	}
}

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
