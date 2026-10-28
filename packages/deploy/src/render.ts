#!/usr/bin/env node
/**
 * Deploy render CLI (SPEC S6): emit the systemd unit files for an org from a
 * live control.db. Pure mapping (`renderUnitFiles`) plus a thin CLI that writes
 * the files out, so the smoke-test script can materialise a real deployment.
 *
 *   node src/deploy/render.ts <control.db> <out-dir>
 *
 * Environment overrides mirror the generators' options:
 *   ORG_CONTROL_SOCKET   shared (admin/dev) socket path (default /var/lib/org/control.sock)
 *   ORG_STATE_DIR        control-plane writable dir   (default dirname of control.db); workers are denied it
 *   ORG_UNIT_SOCKET_DIR  per-unit sockets dir, /run/<name> (default /run/pi-control)
 *   ORG_UNITS_DIR        per-unit state root          (default /var/lib/org-units)
 *   ORG_MANIFEST_DIR     root-owned manifests + secrets.env (default /etc/agentic-pi/units)
 *   ORG_WORKSPACE_ROOT   worker cwd root              (default /srv/org)
 *   ORG_BWRAP_BIN        bwrap binary for bash units  (optional)
 *   ORG_SWEEP_INTERVAL_MS control-plane sweep interval  (optional)
 *   ORG_ETC_DIR          where sysusers.d/tmpfiles.d/polkit files go (default /etc)
 *   ORG_PI_BIN / ORG_PI_CLI / ORG_NODE_BIN  binary paths (ORG_PI_CLI = Pi's cli.js; required for units without tool:bash)
 *   ORG_ENTRYPOINT       pi-control daemon script (default: dist/control-plane.js of the installed pi-agentic-control-plane)
 *   ORG_WORKER_MODE      pi (default) | durable; durable also exports ORG_WORKER_MODE to pi-control.service
 *   ORG_DURABLE_BIN      durable worker script (default: dist/worker.js of the installed pi-agentic-durable)
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ControlStore, type UnitRow } from "pi-agentic-control-plane";
import { formatGrant, type Manifest, parseManifest } from "pi-agentic-core";
import { manifestPathOf, renderControlUnit, renderPolkitRule, renderSysusers, renderTmpfiles, renderWorkerUnit, secretsFileOf, unitServiceName, unitStateDir } from "./systemd.ts";
import { defaultDurableBin, defaultEntrypoint } from "./resolve.ts";

/** Default root-owned manifest dir (ORG_MANIFEST_DIR). */
export const DEFAULT_MANIFEST_DIR = "/etc/agentic-pi/units";

export interface RenderConfig {
	controlDb: string;
	socketPath: string;
	stateDir: string;
	/** Per-unit socket dir, `/run/<name>` (systemd RuntimeDirectory of pi-control). */
	unitSocketDir: string;
	/** Per-unit state root (`<unitsRoot>/<id>`, 0700 owned by pi-u-<id>). */
	unitsRoot: string;
	workspaceRoot: string;
	bwrapBin?: string;
	/** Root-owned manifest dir (default {@link DEFAULT_MANIFEST_DIR}): `<dir>/<id>/{unit.json,secrets.env}`. */
	manifestDir?: string;
	/** Control-plane sweep interval (ms). */
	sweepIntervalMs?: number;
	piBin?: string;
	/** Pi's cli.js; run as `<nodeBin> <piCli>` (no shell launcher). */
	piCli?: string;
	nodeBin?: string;
	/** Worker launch mode (default `pi`). `durable` renders `pi-durable@<id>.service` units instead of `pi-unit@`. */
	workerMode?: "pi" | "durable";
	/** pi-agentic-durable worker script (bin js); required for workerMode=durable. */
	durableBin?: string;
	entrypoint: string;
}

/** Does this unit hold the `tool:bash` grant? */
function unitAllowsBash(unit: UnitRow): boolean {
	return unit.grants.some((g) => g.kind === "tool" && g.name === "bash");
}

/**
 * Map an org's units to a `{ relative path: content }` record. Top-level keys are
 * systemd unit files (one hardened `pi-unit@<id>.service` per unit plus
 * `pi-control.service`); keys with a directory are relative to the etc dir:
 * `sysusers.d/` (users+groups), `tmpfiles.d/` (0700 per-unit state dirs with
 * `agent-dir`) and `polkit-1/rules.d/` (control user may start pi-unit@*).
 */
export function renderUnitFiles(units: readonly UnitRow[], cfg: RenderConfig): Record<string, string> {
	const manifestDir = cfg.manifestDir ?? DEFAULT_MANIFEST_DIR;
	const files: Record<string, string> = {};
	const ids = units.map((u) => u.id);
	files["pi-control.service"] = renderControlUnit({
		controlDb: cfg.controlDb,
		socketPath: cfg.socketPath,
		stateDir: cfg.stateDir,
		unitSocketDir: cfg.unitSocketDir,
		unitIds: ids,
		workspaceRoot: cfg.workspaceRoot,
		manifestDir,
		unitsRoot: cfg.unitsRoot,
		entrypoint: cfg.entrypoint,
		...(cfg.bwrapBin ? { bwrapBin: cfg.bwrapBin } : {}),
		...(cfg.sweepIntervalMs !== undefined ? { sweepIntervalMs: cfg.sweepIntervalMs } : {}),
		...(cfg.nodeBin ? { nodeBin: cfg.nodeBin } : {}),
		...(cfg.workerMode ? { workerMode: cfg.workerMode } : {}),
	});
	const sockOf = (id: string): string => `${cfg.unitSocketDir}/${id}.sock`;
	for (const unit of units) {
		const workspace = join(cfg.workspaceRoot, unit.path);
		files[unitServiceName(unit.id, cfg.workerMode ?? "pi")] = renderWorkerUnit({
			unitId: unit.id,
			workspace,
			socketPath: sockOf(unit.id),
			manifestPath: manifestPathOf(manifestDir, unit.id),
			secretsFile: secretsFileOf(manifestDir, unit.id),
			stateDir: unitStateDir(cfg.unitsRoot, unit.id),
			controlStateDir: cfg.stateDir,
			taskEnvFile: `${cfg.unitSocketDir}/env/${unit.id}.env`,
			otherUnits: units.map((o) => ({ id: o.id, stateDir: unitStateDir(cfg.unitsRoot, o.id), socketPath: sockOf(o.id) })),
			allowBash: unitAllowsBash(unit),
			...(cfg.bwrapBin ? { bwrapBin: cfg.bwrapBin } : {}),
			// Without tool:bash shells are inaccessible, so a launcher can't be used.
			...(cfg.piCli ? { piCli: cfg.piCli, ...(cfg.nodeBin ? { nodeBin: cfg.nodeBin } : {}) } : cfg.piBin ? { piBin: cfg.piBin } : {}),
			...(cfg.workerMode === "durable" ? { mode: "durable" as const, ...(cfg.durableBin ? { durableBin: cfg.durableBin } : {}), ...(cfg.nodeBin ? { nodeBin: cfg.nodeBin } : {}) } : {}),
		});
	}
	files["sysusers.d/agentic-pi.conf"] = renderSysusers(ids, cfg.stateDir);
	files["tmpfiles.d/agentic-pi.conf"] = renderTmpfiles(ids, cfg.unitsRoot, {
		durable: cfg.workerMode === "durable",
		manifestDir,
		workspaces: Object.fromEntries(units.map((u) => [u.id, join(cfg.workspaceRoot, u.path)])),
	});
	files["polkit-1/rules.d/50-agentic-pi.rules"] = renderPolkitRule();
	return files;
}

/** The manifest JSON a unit row implies (secrets/trust are not stored in the db, so they are empty). */
function manifestFromRow(u: UnitRow): Manifest {
	return {
		id: u.id,
		path: u.path,
		parent: u.parent,
		owner: u.owner,
		grants: u.grants,
		budget: u.budget,
		limits: u.limits,
		expiresAt: u.expiresAt,
		minEval: u.minEval,
		secrets: [],
		trust: [],
	};
}

/**
 * Authored manifests: `<workspaceRoot>/<unit.path>/unit.json` from the org repo, when present.
 * Each is validated with parseManifest and must carry the unit's own id.
 */
export function loadSourceManifests(units: readonly UnitRow[], workspaceRoot: string): Map<string, Manifest> {
	const out = new Map<string, Manifest>();
	for (const u of units) {
		const p = join(workspaceRoot, u.path, "unit.json");
		if (!existsSync(p)) continue;
		const m = parseManifest(JSON.parse(readFileSync(p, "utf8")));
		if (m.id !== u.id) throw new Error(`${p} declares id ${m.id}, expected ${u.id}`);
		out.set(u.id, m);
	}
	return out;
}

/**
 * `{ absolute path: content }` for the root-owned manifests (`<manifestDir>/<id>/unit.json`, to be
 * written 0644 root:root). Uses the authored source manifest when given, else derives one from the db row.
 */
export function renderManifestFiles(units: readonly UnitRow[], sources: ReadonlyMap<string, Manifest>, manifestDir: string = DEFAULT_MANIFEST_DIR): Record<string, string> {
	const out: Record<string, string> = {};
	for (const u of units) {
		const m = sources.get(u.id) ?? manifestFromRow(u);
		out[manifestPathOf(manifestDir, u.id)] = `${JSON.stringify({ ...m, grants: m.grants.map(formatGrant) }, null, 2)}\n`;
	}
	return out;
}

function main(argv: string[]): void {
	const controlDb = argv[0];
	const outDir = argv[1];
	if (!controlDb || !outDir) {
		process.stderr.write("usage: render.ts <control.db> <out-dir>\n");
		process.exit(2);
	}
	const workerMode = process.env.ORG_WORKER_MODE ?? "pi";
	if (workerMode !== "pi" && workerMode !== "durable") {
		process.stderr.write(`ORG_WORKER_MODE must be pi|durable, got ${JSON.stringify(workerMode)}\n`);
		process.exit(2);
	}
	const cfg: RenderConfig = {
		controlDb,
		socketPath: process.env.ORG_CONTROL_SOCKET ?? "/var/lib/org/control.sock",
		stateDir: process.env.ORG_STATE_DIR ?? dirname(controlDb),
		unitSocketDir: process.env.ORG_UNIT_SOCKET_DIR ?? "/run/pi-control",
		unitsRoot: process.env.ORG_UNITS_DIR ?? "/var/lib/org-units",
		...(process.env.ORG_SWEEP_INTERVAL_MS ? { sweepIntervalMs: Number(process.env.ORG_SWEEP_INTERVAL_MS) } : {}),
		...(process.env.ORG_BWRAP_BIN ? { bwrapBin: process.env.ORG_BWRAP_BIN } : {}),
		workspaceRoot: process.env.ORG_WORKSPACE_ROOT ?? "/srv/org",
		entrypoint: process.env.ORG_ENTRYPOINT ?? defaultEntrypoint(),
		...(process.env.ORG_PI_CLI ? { piCli: process.env.ORG_PI_CLI } : {}),
		...(process.env.ORG_PI_BIN ? { piBin: process.env.ORG_PI_BIN } : {}),
		...(process.env.ORG_NODE_BIN ? { nodeBin: process.env.ORG_NODE_BIN } : {}),
		...(workerMode === "durable" ? { workerMode, durableBin: process.env.ORG_DURABLE_BIN ?? defaultDurableBin() } : {}),
		...(process.env.ORG_MANIFEST_DIR ? { manifestDir: process.env.ORG_MANIFEST_DIR } : {}),
	};
	const store = new ControlStore(controlDb, {});
	try {
		const units = store.listUnits();
		const files = renderUnitFiles(units, cfg);
		const etcDir = process.env.ORG_ETC_DIR ?? "/etc";
		for (const [name, content] of Object.entries(files)) {
			// Keys with a directory (sysusers.d/...) live under the etc dir; unit files under outDir.
			const dest = name.includes("/") ? join(etcDir, name) : join(outDir, name);
			mkdirSync(dirname(dest), { recursive: true });
			writeFileSync(dest, content, { mode: 0o644 });
			process.stdout.write(`wrote ${dest}\n`);
		}
		// Root-owned manifests: world-readable, writable by root only (never inside a unit-writable path).
		for (const [dest, content] of Object.entries(renderManifestFiles(units, loadSourceManifests(units, cfg.workspaceRoot), cfg.manifestDir))) {
			mkdirSync(dirname(dest), { recursive: true });
			writeFileSync(dest, content, { mode: 0o644 });
			chmodSync(dest, 0o644);
			process.stdout.write(`wrote ${dest}\n`);
		}
	} finally {
		store.close();
	}
}

if (import.meta.main) main(process.argv.slice(2));