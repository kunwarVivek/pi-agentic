/**
 * Release readiness check (no publishing). From a clean build:
 *   1. `npm pack` every publishable workspace into ./.tmp/pack and audit each tarball
 *      (dist + README + LICENSE present; no src/tests; pi manifest/bins resolve inside it);
 *   2. `npm publish --dry-run` for each package, in dependency order;
 *   3. install the tarballs into an isolated consumer (./.tmp/release-consumer, no workspace
 *      symlinks), `pi install` the installed extension into an isolated PI_CODING_AGENT_DIR,
 *      `pi list`, then run the real `pi` headless against a fake model with the extension
 *      loaded only from that installed package (scripts/release-check-consumer.mjs).
 * Needs network for the host-version Pi deps of pi-agentic-durable (npm registry) and `pi` on PATH.
 *   npm run release:check
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const tmp = join(repo, ".tmp");
const packDir = join(tmp, "pack");
const consumer = join(tmp, "release-consumer");
/** Publish order: dependencies first (this is also the order printed in the report). */
const ORDER = ["core", "control-plane", "deploy", "extension", "cli", "evals", "durable"];
const log = (m: string) => process.stdout.write(`${m}\n`);
const fail = (m: string): never => {
	throw new Error(`release:check FAIL: ${m}`);
};
const run = (cmd: string, args: string[], cwd = repo, env: NodeJS.ProcessEnv = process.env): string => {
	const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (r.status !== 0) fail(`${cmd} ${args.join(" ")} (cwd ${cwd}) exited ${r.status}\n${r.stdout}\n${r.stderr}`);
	return r.stdout + r.stderr;
};

interface Pkg { name: string; version: string; dir: string; json: Record<string, unknown> }
const pkgs: Pkg[] = ORDER.map((n) => {
	const dir = join(repo, "packages", n);
	const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	return { name: json.name, version: json.version, dir, json };
});

// --- static metadata gates ---------------------------------------------------------------
const rootLicense = readFileSync(join(repo, "LICENSE"), "utf8");
const HOST = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
for (const p of pkgs) {
	const j = p.json as Record<string, any>;
	if (j.license !== "MIT") fail(`${p.name}: license must be MIT`);
	if (j.engines?.node !== ">=24") fail(`${p.name}: engines.node must be >=24`);
	if (j.publishConfig?.access !== "public") fail(`${p.name}: publishConfig.access must be public`);
	if (j.private) fail(`${p.name}: private`);
	if (!j.description || !j.keywords?.length) fail(`${p.name}: description/keywords missing`);
	if (!j.files?.includes("dist") || !j.files.includes("README.md") || !j.files.includes("LICENSE")) fail(`${p.name}: files must cover dist, README.md, LICENSE`);
	if (j.scripts?.prepack !== "tsc --build") fail(`${p.name}: prepack must build`);
	if (readFileSync(join(p.dir, "LICENSE"), "utf8") !== rootLicense) fail(`${p.name}: LICENSE differs from root LICENSE`);
	for (const [k, v] of Object.entries<any>(j.exports ?? {})) if (!String(v.default).startsWith("./dist/") || !String(v.development).startsWith("./src/")) fail(`${p.name}: export ${k} must be default->dist, development->src`);
	for (const [dep, range] of Object.entries<string>(j.dependencies ?? {})) {
		if (pkgs.some((q) => q.name === dep) && range !== p.version) fail(`${p.name}: ${dep} must be pinned to ${p.version}`);
		if (HOST.includes(dep) && p.name === "pi-agentic") fail(`${p.name}: host package ${dep} must not be in dependencies`);
	}
}
const ext = pkgs.find((p) => p.name === "pi-agentic")!.json as Record<string, any>;
if (!ext.keywords.includes("pi-package")) fail("extension: keywords must include pi-package");
if (JSON.stringify(ext.pi?.extensions) !== JSON.stringify(["./dist/index.js"])) fail("extension: pi.extensions must be ./dist/index.js");

// --- 1. pack ------------------------------------------------------------------------------
rmSync(packDir, { recursive: true, force: true });
mkdirSync(packDir, { recursive: true });
run("npm", ["run", "build"]);
const tgz = new Map<string, string>();
for (const p of pkgs) {
	// `npm pack` runs prepack (tsc --build) itself.
	const out = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDir, "-w", p.dir.slice(repo.length + 1)], repo).match(/\[\s*\{[\s\S]*\}\s*\]/)![0]);
	const files: string[] = out[0].files.map((f: { path: string }) => f.path);
	const need = ["package.json", "README.md", "LICENSE"];
	for (const f of need) if (!files.includes(f)) fail(`${p.name} tarball lacks ${f}`);
	if (!files.some((f) => f.startsWith("dist/") && f.endsWith(".js"))) fail(`${p.name} tarball has no dist js`);
	const bad = files.filter((f) => f.startsWith("src/") || f.startsWith("test/") || f.endsWith(".test.js") || f.endsWith(".tsbuildinfo"));
	if (bad.length) fail(`${p.name} tarball contains non-release files: ${bad.join(", ")}`);
	const j = p.json as Record<string, any>;
	const targets = [...Object.values<string>(typeof j.bin === "object" ? j.bin : {}), ...(j.pi?.extensions ?? []), ...Object.values<any>(j.exports ?? {}).flatMap((v) => [v.default, v.types])];
	for (const t of targets) if (!files.includes(t.replace(/^\.\//, ""))) fail(`${p.name}: ${t} is referenced by package.json but missing from the tarball`);
	tgz.set(p.name, join(packDir, out[0].filename));
	log(`packed ${out[0].filename} (${files.length} files, ${out[0].size} bytes)`);
}

// --- 2. publish --dry-run -----------------------------------------------------------------
for (const p of pkgs) {
	// Pin the loglevel: `npm run -s release:check` exports npm_config_loglevel=silent, which would empty this output.
	const o = run("npm", ["publish", "--dry-run", "--access", "public", "--loglevel", "notice", "-w", p.dir.slice(repo.length + 1)], repo);
	if (!o.includes(`${p.name}@${p.version}`) || !/dry-run/i.test(o)) fail(`${p.name}: unexpected publish --dry-run output\n${o}`);
	log(`dry-run ok: ${p.name}@${p.version}`);
}

// --- 3. isolated consumer -----------------------------------------------------------------
rmSync(consumer, { recursive: true, force: true });
mkdirSync(consumer, { recursive: true });
const fileSpec = (name: string) => `file:${tgz.get(name)}`;
writeFileSync(
	join(consumer, "package.json"),
	JSON.stringify({
		name: "release-consumer",
		private: true,
		type: "module",
		dependencies: Object.fromEntries(pkgs.map((p) => [p.name, fileSpec(p.name)])),
		// Inter-package dependencies pin 0.1.0 from the (not yet published) registry: route them to the tarballs.
		overrides: Object.fromEntries(pkgs.map((p) => [p.name, fileSpec(p.name)])),
	}),
);
run("npm", ["install", "--no-audit", "--no-fund", "--install-links=false"], consumer);
for (const p of pkgs) {
	const d = join(consumer, "node_modules", p.name);
	if (!existsSync(join(d, "package.json")) || lstatSync(d).isSymbolicLink()) fail(`${p.name} in consumer is missing or a symlink`);
}
// Importable by name through the default (dist) condition, no `development`.
for (const p of pkgs) run("node", ["--input-type=module", "-e", `await import(${JSON.stringify(p.name)})`], consumer);
log("consumer: all 7 tarballs installed as real directories and import by name");
// bins land in node_modules/.bin
for (const bin of ["org", "pi-control", "org-render", "agentic-pi-durable-worker"]) if (!existsSync(join(consumer, "node_modules", ".bin", bin))) fail(`bin ${bin} not linked in consumer`);

const agentDir = join(consumer, "agent");
mkdirSync(agentDir, { recursive: true });
const piEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
const extDir = join(consumer, "node_modules", "pi-agentic");
log(run("pi", ["install", extDir], consumer, piEnv).trim());
const listed = run("pi", ["list"], consumer, piEnv);
log(listed.trim());
if (!listed.includes("pi-agentic")) fail("pi list does not show the installed extension");

// --- 4. headless load from the installed package -----------------------------------------
copyFileSync(join(repo, "scripts", "release-check-consumer.mjs"), join(consumer, "release-check-consumer.mjs"));
log(run("node", ["release-check-consumer.mjs", agentDir, join(consumer, "work")], consumer, piEnv).trim());
log("RELEASE CHECK PASS");
