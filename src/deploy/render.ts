/**
 * Deploy render CLI (SPEC S6): emit the systemd unit files for an org from a
 * live control.db. Pure mapping (`renderUnitFiles`) plus a thin CLI that writes
 * the files out, so the smoke-test script can materialise a real deployment.
 *
 *   node src/deploy/render.ts <control.db> <out-dir>
 *
 * Environment overrides mirror the generators' options:
 *   ORG_CONTROL_SOCKET   socket path baked into units (default /var/lib/org/control.sock)
 *   ORG_STATE_DIR        control-plane writable dir   (default dirname of control.db)
 *   ORG_WORKSPACE_ROOT   worker cwd root              (default /srv/org)
 *   ORG_PI_BIN / ORG_NODE_BIN / ORG_ENTRYPOINT  binary + entrypoint paths
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ControlStore, type UnitRow } from "../store/control.ts";
import { renderControlUnit, renderWorkerUnit, unitServiceName } from "./systemd.ts";

export interface RenderConfig {
	controlDb: string;
	socketPath: string;
	stateDir: string;
	workspaceRoot: string;
	piBin?: string;
	nodeBin?: string;
	entrypoint: string;
}

/** Does this unit hold the `tool:bash` grant? */
function unitAllowsBash(unit: UnitRow): boolean {
	return unit.grants.some((g) => g.kind === "tool" && g.name === "bash");
}

/**
 * Map an org's units to a `{ filename: content }` record: one hardened worker
 * unit template per org unit, plus the control-plane unit. Worker units are
 * templates — the dispatcher fills ORG_TASK_ID per launch — so taskId is left
 * as the systemd specifier `%i` placeholder.
 */
export function renderUnitFiles(units: readonly UnitRow[], cfg: RenderConfig): Record<string, string> {
	const files: Record<string, string> = {};
	files["pi-control.service"] = renderControlUnit({
		controlDb: cfg.controlDb,
		socketPath: cfg.socketPath,
		stateDir: cfg.stateDir,
		entrypoint: cfg.entrypoint,
		...(cfg.nodeBin ? { nodeBin: cfg.nodeBin } : {}),
	});
	for (const unit of units) {
		files[unitServiceName(unit.id)] = renderWorkerUnit({
			unitId: unit.id,
			workspace: join(cfg.workspaceRoot, unit.path),
			socketPath: cfg.socketPath,
			controlDb: cfg.controlDb,
			taskId: "%i",
			allowBash: unitAllowsBash(unit),
			...(cfg.piBin ? { piBin: cfg.piBin } : {}),
		});
	}
	return files;
}

function main(argv: string[]): void {
	const controlDb = argv[0];
	const outDir = argv[1];
	if (!controlDb || !outDir) {
		process.stderr.write("usage: render.ts <control.db> <out-dir>\n");
		process.exit(2);
	}
	const cfg: RenderConfig = {
		controlDb,
		socketPath: process.env.ORG_CONTROL_SOCKET ?? "/var/lib/org/control.sock",
		stateDir: process.env.ORG_STATE_DIR ?? dirname(controlDb),
		workspaceRoot: process.env.ORG_WORKSPACE_ROOT ?? "/srv/org",
		entrypoint: process.env.ORG_ENTRYPOINT ?? "/opt/agentic-pi/src/rpc/control-plane.ts",
		...(process.env.ORG_PI_BIN ? { piBin: process.env.ORG_PI_BIN } : {}),
		...(process.env.ORG_NODE_BIN ? { nodeBin: process.env.ORG_NODE_BIN } : {}),
	};
	const store = new ControlStore(controlDb, {});
	try {
		const files = renderUnitFiles(store.listUnits(), cfg);
		mkdirSync(outDir, { recursive: true });
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(outDir, name), content, { mode: 0o644 });
			process.stdout.write(`wrote ${join(outDir, name)}\n`);
		}
	} finally {
		store.close();
	}
}

if (import.meta.main) main(process.argv.slice(2));
