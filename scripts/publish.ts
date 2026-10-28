/**
 * Release every workspace package to npm and the source to GitHub, as one versioned release.
 *
 *   pnpm run publish <patch|minor|major|X.Y.Z> [--dry-run] [--otp <code>]
 *   pnpm run publish                 # resume: publish the current version (after a partial run)
 *   (`npm run publish -- ...` is equivalent. Bare `pnpm publish` is pnpm's built-in command,
 *   which refuses the private root package; it never runs this script.)
 *
 * Steps, failing closed at each:
 *   1. preflight: on `main`, clean tree, not behind origin/main, all packages share one version,
 *      npm and gh logged in, tag vX.Y.Z free, CHANGELOG has `## [X.Y.Z]` or a non-empty `## [Unreleased]`;
 *   2. bump: every package version and every exact inter-package pin to X.Y.Z, the CHANGELOG
 *      `Unreleased` heading to `[X.Y.Z] - <date>`, package-lock.json;
 *   3. gates: npm run check, smoke:pi, simulate:org, release:check;
 *      (--dry-run stops here, prints the plan, and restores the bumped files);
 *   4. git: commit `release: vX.Y.Z`, annotated tag vX.Y.Z (message = changelog section), push main + tag;
 *   5. npm: `npm publish` each package in dependency order, skipping versions already on the registry
 *      (2FA: npm prints a browser approval link, or pass --otp);
 *   6. GitHub Release vX.Y.Z with the changelog section as notes;
 *   7. verify: every package@X.Y.Z is visible on the registry with the shasum of the local pack.
 * A failure before the commit restores the bumped files; a failure after it is resumed by re-running
 * `pnpm run publish` with no version (already-done steps are skipped).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadWorkspacePackages } from "./workspace-packages.ts";

const repo = resolve(import.meta.dirname, "..");
const log = (m: string) => process.stdout.write(`publish: ${m}\n`);
const fail = (m: string): never => {
	throw new Error(m);
};

/** Captured run; returns status + output, never throws. */
const sh = (cmd: string, args: string[]) => {
	const r = spawnSync(cmd, args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), stdout: (r.stdout ?? "").trim() };
};
const must = (cmd: string, args: string[]) => {
	const r = sh(cmd, args);
	if (!r.ok) fail(`${cmd} ${args.join(" ")} failed:\n${r.out}`);
	return r.stdout;
};
/** Interactive run (inherits the terminal: gate output, npm's 2FA prompt). */
const live = (cmd: string, args: string[]) => {
	log(`$ ${cmd} ${args.join(" ")}`);
	const r = spawnSync(cmd, args, { cwd: repo, stdio: "inherit" });
	if (r.status !== 0) fail(`${cmd} ${args.join(" ")} exited ${r.status}`);
};

// --- args -----------------------------------------------------------------------------------
let target: string | undefined;
let dryRun = false;
let otp: string | undefined;
const argv = process.argv.slice(2).filter((a) => a !== "--"); // `pnpm run x -- y` forwards the `--`
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]!;
	if (a === "--dry-run") dryRun = true;
	else if (a === "--otp") otp = argv[++i] ?? fail("--otp needs a code");
	else if (a.startsWith("--otp=")) otp = a.slice(6);
	else if (a === "-h" || a === "--help") {
		process.stdout.write("usage: pnpm run publish [patch|minor|major|X.Y.Z] [--dry-run] [--otp <code>]\n");
		process.exit(0);
	} else if (!a.startsWith("-") && target === undefined) target = a;
	else fail(`unknown argument '${a}'`);
}

type Semver = [number, number, number];
const parseSemver = (v: string): Semver => {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
	if (!m) return fail(`'${v}' is not a plain X.Y.Z version`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const cmpSemver = (a: Semver, b: Semver) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const pkgs = loadWorkspacePackages(repo);
const BUMPED = [...pkgs.map((p) => join(p.rel, "package.json")), "package-lock.json", "CHANGELOG.md"];
const snapshot = new Map(BUMPED.map((f) => [f, readFileSync(join(repo, f), "utf8")]));
const restore = () => {
	for (const [f, text] of snapshot) writeFileSync(join(repo, f), text);
};
let committed = false;

function changelogSection(text: string, version: string): string | undefined {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
	if (start < 0) return undefined;
	const end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
	return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

async function main(): Promise<void> {
	// --- 1. preflight -------------------------------------------------------------------------
	const versions = new Set(pkgs.map((p) => p.version));
	if (versions.size !== 1) fail(`packages are not on one version: ${pkgs.map((p) => `${p.name}@${p.version}`).join(", ")}`);
	const current = pkgs[0]!.version;
	const cur = parseSemver(current);
	const version =
		target === undefined || target === current
			? current
			: target === "patch"
				? `${cur[0]}.${cur[1]}.${cur[2] + 1}`
				: target === "minor"
					? `${cur[0]}.${cur[1] + 1}.0`
					: target === "major"
						? `${cur[0] + 1}.0.0`
						: target;
	const resume = version === current;
	if (!resume && cmpSemver(parseSemver(version), cur) <= 0) fail(`${version} is not greater than the current ${current}`);
	const tag = `v${version}`;

	const branch = must("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch !== "main") fail(`releases are cut from main (on '${branch}')`);
	const dirty = must("git", ["status", "--porcelain"]);
	if (dirty && !dryRun) fail(`working tree is not clean:\n${dirty}`);
	if (dirty) log("warning: working tree is dirty (allowed for --dry-run only)");
	must("git", ["fetch", "--quiet", "--tags", "origin", "main"]);
	const behind = Number(must("git", ["rev-list", "--count", "HEAD..origin/main"]));
	if (behind > 0) fail(`main is ${behind} commit(s) behind origin/main; pull first`);

	const head = must("git", ["rev-parse", "HEAD"]);
	const localTag = sh("git", ["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]);
	const remoteTag = must("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
	if (!resume && (localTag.ok || remoteTag)) fail(`tag ${tag} already exists`);
	if (resume && localTag.ok && localTag.stdout !== head) fail(`tag ${tag} exists but is not HEAD; resume only from the release commit`);

	const who = sh("npm", ["whoami"]);
	if (!who.ok) (dryRun ? log : fail)("npm is not logged in (run `npm login`)");
	else log(`npm user: ${who.stdout}`);
	const gh = sh("gh", ["auth", "status"]);
	if (!gh.ok) (dryRun ? log : fail)("gh is not installed or not logged in (run `gh auth login`)");

	let changelog = snapshot.get("CHANGELOG.md")!;
	if (changelogSection(changelog, version) === undefined) {
		if (resume) fail(`CHANGELOG.md has no '## [${version}]' section`);
		const unreleased = changelogSection(changelog, "Unreleased");
		if (!unreleased) fail(`CHANGELOG.md needs a '## [${version}]' section or a non-empty '## [Unreleased]' section`);
		const date = new Date().toISOString().slice(0, 10);
		changelog = changelog.replace(/^## \[Unreleased\].*$/m, `## [${version}] - ${date}`);
	}
	const notes = changelogSection(changelog, version)!;
	log(`${resume ? "resuming" : `releasing ${current} ->`} ${version}; publish order: ${pkgs.map((p) => p.name).join(", ")}`);

	// --- 2. bump ------------------------------------------------------------------------------
	if (!resume) {
		const names = new Set(pkgs.map((p) => p.name));
		for (const p of pkgs) {
			const j = JSON.parse(snapshot.get(join(p.rel, "package.json"))!);
			j.version = version;
			for (const dep of Object.keys(j.dependencies ?? {})) if (names.has(dep)) j.dependencies[dep] = version;
			writeFileSync(join(p.dir, "package.json"), `${JSON.stringify(j, null, "\t")}\n`);
		}
		writeFileSync(join(repo, "CHANGELOG.md"), changelog);
		must("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
		// Workspace deps must stay symlinked to the checkout, never fetched from the registry.
		for (const p of pkgs) {
			const nm = join(p.dir, "node_modules");
			const nested = existsSync(nm) ? readdirSync(nm).filter((d) => names.has(d)) : [];
			if (nested.length) fail(`${p.rel}/node_modules has registry copies of ${nested.join(", ")}; remove them and re-run`);
		}
		log(`bumped ${pkgs.length} packages and their pins to ${version}`);
	}

	// --- 3. gates (already passed for a tagged release commit being resumed) -------------------
	if (resume && localTag.ok) log(`HEAD is ${tag}; gates passed before it was tagged, skipping them`);
	else for (const gate of ["check", "smoke:pi", "simulate:org", "release:check"]) live("npm", ["run", gate]);

	const onRegistry = (name: string) => sh("npm", ["view", `${name}@${version}`, "version", "--prefer-online"]).stdout === version;
	if (dryRun) {
		log(`dry run: gates passed. Would commit 'release: ${tag}', tag ${tag}, push main + ${tag}, then publish:`);
		for (const p of pkgs) log(`  ${p.name}@${version}${onRegistry(p.name) ? " (already on npm, skip)" : ""}`);
		log(`and create GitHub Release ${tag}. Restoring the bumped files.`);
		restore();
		return;
	}

	// --- 4. git -------------------------------------------------------------------------------
	if (!resume) {
		must("git", ["add", ...BUMPED]);
		must("git", ["commit", "--quiet", "-m", `release: ${tag}`]);
		committed = true;
	}
	const tmp = join(repo, ".tmp");
	mkdirSync(tmp, { recursive: true });
	const notesFile = join(tmp, `release-notes-${tag}.md`);
	writeFileSync(notesFile, `${tag}\n\n${notes}\n`);
	if (!sh("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).ok) must("git", ["tag", "-a", tag, "-F", notesFile]);
	live("git", ["push", "origin", "HEAD:main"]);
	live("git", ["push", "origin", tag]);

	// --- 5. npm -------------------------------------------------------------------------------
	for (const p of pkgs) {
		if (onRegistry(p.name)) {
			log(`${p.name}@${version} already on npm, skipping`);
			continue;
		}
		live("npm", ["publish", "-w", p.rel, "--access", "public", ...(otp ? ["--otp", otp] : [])]);
	}

	// --- 6. GitHub Release --------------------------------------------------------------------
	if (sh("gh", ["release", "view", tag]).ok) log(`GitHub Release ${tag} already exists`);
	else live("gh", ["release", "create", tag, "--verify-tag", "--title", tag, "--notes-file", notesFile]);

	// --- 7. verify ----------------------------------------------------------------------------
	// The registry can take minutes to list a fresh version ("being processed").
	const pending = new Map(pkgs.map((p) => [p.name, p]));
	const deadline = Date.now() + 10 * 60_000;
	while (pending.size > 0) {
		for (const p of [...pending.values()]) {
			const pub = sh("npm", ["view", `${p.name}@${version}`, "dist.shasum", "--prefer-online"]).stdout;
			if (!pub) continue;
			const local = JSON.parse(must("npm", ["pack", "--dry-run", "--json", "--loglevel=error", "-w", p.rel]))[0].shasum;
			if (pub !== local) fail(`${p.name}@${version} on npm (${pub}) differs from the local pack (${local})`);
			log(`verified ${p.name}@${version} (${pub})`);
			pending.delete(p.name);
		}
		if (pending.size === 0) break;
		if (Date.now() > deadline) fail(`not visible on npm after 10 minutes: ${[...pending.keys()].join(", ")}; re-run to resume`);
		log(`waiting for the registry to list: ${[...pending.keys()].join(", ")}`);
		await new Promise((r) => setTimeout(r, 15_000));
	}
	log(`released ${tag}: ${pkgs.length} packages on npm, tag + GitHub Release on origin`);
}

try {
	await main();
} catch (e) {
	// Nothing committed yet: put any bumped files back (a no-op if none were written).
	if (!committed) restore();
	process.stderr.write(`publish FAIL: ${(e as Error).message}\n`);
	if (committed) process.stderr.write("The release commit exists: fix the cause, then re-run `pnpm run publish` (no version) to resume.\n");
	process.exit(1);
}
