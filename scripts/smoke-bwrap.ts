/**
 * S6 smoke: run a bash command under the bwrap sandbox built from eng's grants
 * (rw on /srv/org/eng only). The caller asserts the exit code — a command that
 * touches anything outside the grants must fail.
 *   node scripts/smoke-bwrap.ts "<bash command>"
 */
import { spawnSync } from "node:child_process";
import { buildBwrapCommand } from "@agentic-pi/deploy";
import { parseGrants } from "@agentic-pi/core";

const command = process.argv[2];
if (!command) {
	process.stderr.write('usage: smoke-bwrap.ts "<bash command>"\n');
	process.exit(2);
}
const grants = parseGrants(["path:rw:/srv/org/eng/**"]);
const argv = buildBwrapCommand({ grants, command, workspace: "/srv/org/eng" });
const [bin, ...rest] = argv;
if (!bin) throw new Error("empty bwrap argv");
const r = spawnSync(bin, rest, { stdio: "inherit" });
process.exit(r.status ?? 1);
