/**
 * Default entrypoint resolution (agentic-pi-3sr.5): org-render finds the INSTALLED daemon / worker
 * scripts instead of a hard-coded /opt path, and exports ORG_WORKER_MODE to pi-control.service.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultDurableBin, defaultEntrypoint, resolveDistFile } from "../src/resolve.ts";
import { renderControlUnit } from "../src/systemd.ts";

function fakePkg(layout: "dist" | "src"): { root: string; main: string } {
	const root = mkdtempSync(join(tmpdir(), "agentic-pi-resolve-"));
	mkdirSync(join(root, "dist"), { recursive: true });
	mkdirSync(join(root, layout), { recursive: true });
	writeFileSync(join(root, "dist", "control-plane.js"), "");
	return { root, main: join(root, layout, layout === "dist" ? "index.js" : "index.ts") };
}

test("resolveDistFile uses the resolved package's dist file", () => {
	const { root, main } = fakePkg("dist");
	try {
		assert.equal(resolveDistFile("pkg", "control-plane.js", () => main), join(root, "dist", "control-plane.js"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveDistFile maps a src/ checkout (development condition) to the built dist/", () => {
	const { root, main } = fakePkg("src");
	try {
		assert.equal(resolveDistFile("pkg", "control-plane.js", () => main), join(root, "dist", "control-plane.js"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveDistFile fails closed when the package or the built file is missing", () => {
	const { root, main } = fakePkg("dist");
	try {
		assert.throws(() => resolveDistFile("pkg", "worker.js", () => main), /build pkg first/);
		assert.throws(
			() =>
				resolveDistFile("pkg", "x.js", () => {
					throw new Error("not found");
				}),
			/cannot resolve pkg/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("defaults resolve to the installed workspace packages' built bins", () => {
	const entry = defaultEntrypoint();
	assert.match(entry, /control-plane[\\/]dist[\\/]control-plane\.js$/);
	assert.ok(existsSync(entry));
	assert.ok(!entry.startsWith("/opt/"));
	assert.match(defaultDurableBin(), /durable[\\/]dist[\\/]worker\.js$/);
});

test("renderControlUnit exports ORG_WORKER_MODE only when a mode is given", () => {
	const base = {
		controlDb: "/var/lib/org/control.db",
		socketPath: "/var/lib/org/control.sock",
		stateDir: "/var/lib/org",
		unitSocketDir: "/run/pi-control",
		unitIds: ["ceo"],
		workspaceRoot: "/srv/org",
		unitsRoot: "/var/lib/org-units",
		entrypoint: "/opt/x/control-plane.js",
	};
	assert.doesNotMatch(renderControlUnit(base), /ORG_WORKER_MODE/);
	assert.match(renderControlUnit({ ...base, workerMode: "durable" }), /^Environment=ORG_WORKER_MODE=durable$/m);
});
