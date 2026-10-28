/**
 * Default entrypoint resolution for `org-render`: locate the daemon / worker scripts inside the
 * INSTALLED agentic-pi packages (never a hard-coded /opt path).
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

/**
 * Absolute path of `<pkg>/dist/<file>`. The package's main entry is resolved with node's own
 * resolver (so it follows whatever node_modules layout is installed); when that lands in `src/`
 * (workspace checkout run with `--conditions development`) the sibling `dist/` is used, because
 * systemd runs the built JavaScript. Throws when the built file is missing.
 */
export function resolveDistFile(pkg: string, file: string, resolveMain: (id: string) => string = createRequire(import.meta.url).resolve): string {
	let main: string;
	try {
		main = resolveMain(pkg);
	} catch (e) {
		throw new Error(`cannot resolve ${pkg} (is it installed?): ${(e as Error).message}`);
	}
	let dir = dirname(main);
	if (basename(dir) === "src") dir = join(dirname(dir), "dist");
	const out = join(dir, file);
	if (!existsSync(out)) throw new Error(`${out} does not exist: build ${pkg} first (npm run build)`);
	return out;
}

/** The installed pi-agentic-control-plane daemon (`pi-control` bin). */
export function defaultEntrypoint(): string {
	return resolveDistFile("pi-agentic-control-plane", "control-plane.js");
}

/** The installed pi-agentic-durable worker (`agentic-pi-durable-worker` bin). */
export function defaultDurableBin(): string {
	return resolveDistFile("pi-agentic-durable", "worker.js");
}
