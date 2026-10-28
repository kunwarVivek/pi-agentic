/**
 * S6 smoke: export an audit anchor, tamper with the chain behind the store's
 * back, and assert the anchor detects it. Proves the off-host anchor closes
 * the residual "rewrite the whole chain" threat.
 *   node scripts/smoke-anchor.ts <control.db>
 */
import { DatabaseSync } from "node:sqlite";
import { ControlStore } from "pi-agentic-control-plane";

const db = process.argv[2];
if (!db) {
	process.stderr.write("usage: smoke-anchor.ts <control.db>\n");
	process.exit(2);
}
const store = new ControlStore(db, {});
const anchor = store.exportAnchor();
const before = store.verifyAnchor(anchor);
if (!before.ok) throw new Error(`live chain did not match its own anchor: ${JSON.stringify(before)}`);
store.close();

// Tamper: flip an actor on the head row directly in sqlite.
const raw = new DatabaseSync(db);
// audit is append-only via triggers; drop the UPDATE trigger on this raw connection to simulate an attacker with file access.
raw.exec("DROP TRIGGER IF EXISTS audit_no_update");
raw.exec("UPDATE audit SET actor = 'mallory:x' WHERE seq = (SELECT MAX(seq) FROM audit)");
raw.close();

const reopened = new ControlStore(db, {});
try {
	const after = reopened.verifyAnchor(anchor);
	if (after.ok) throw new Error("anchor FAILED to detect a tampered chain");
	process.stdout.write(`anchor detected tampering: ${after.reason} (${after.detail})\n`);
} finally {
	reopened.close();
}
