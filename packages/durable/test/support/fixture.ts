/**
 * Test fixture: a real ControlStore + ControlServer on a unix socket, a task
 * dispatched through the real Dispatcher in durable mode, and a scripted pi-ai
 * faux model. All state lives under ./.tmp in the repo (short paths for the
 * socket).
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PeerRegistry, ControlServer, ControlStore, Dispatcher, type WorkerSpec } from "pi-agentic-control-plane";
import { parseManifest, type Budget, type Contract, type Manifest } from "pi-agentic-core";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";

export const BIG: Budget = { tokens: 1_000_000, costUsd: 1000, wallClockSec: 1_000_000 };

export const CONTRACT: Contract = {
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["summary"],
		properties: { summary: { type: "string", minLength: 1 } },
	},
};

const REPO_TMP = resolve(import.meta.dirname, "../../../../.tmp");

export interface Fixture {
	root: string;
	/** Realpath of the unit's workspace; `path:rw:<workspace>/**` is granted. */
	workspace: string;
	/** A directory the unit holds NO grant for. */
	outside: string;
	/** The sales unit's manifest file (outside its writable grants). */
	manifestPath: string;
	store: ControlStore;
	socketPath: string;
	token: string;
	faux: FauxProviderHandle;
	models: Models;
	model: { provider: string; modelId: string };
	/** Delegate a task ceo → sales and dispatch it in durable mode; returns the worker spec. */
	dispatch(taskBudget?: Budget): Promise<WorkerSpec>;
	cleanup(): Promise<void>;
}

export interface FixtureOptions {
	/** Extra grants for the `sales` unit (e.g. `tool:bash`). */
	salesGrants?: string[];
	/** Manifest `secrets` env var names for `sales`. */
	salesSecrets?: string[];
}

export async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
	mkdirSync(REPO_TMP, { recursive: true });
	const root = join(REPO_TMP, `d-${randomBytes(4).toString("hex")}`);
	mkdirSync(root, { recursive: true });
	const real = realpathSync(root);
	const workspace = join(real, "ws");
	const outside = join(real, "outside");
	mkdirSync(workspace);
	mkdirSync(outside);

	const raw = (id: string, path: string, parent: string | null, grants: string[], secrets: string[] = []) => ({ id, path, parent, owner: `${id}@co`, grants, budget: BIG, secrets });
	const man = (id: string, path: string, parent: string | null, grants: string[]): Manifest => parseManifest(raw(id, path, parent, grants));
	const store = new ControlStore(join(real, "control.db"));
	store.addUnit(man("ceo", "ceo", null, ["tool:read", "delegate:*", `path:rw:${real}/**`]));
	const salesRaw = raw("sales", "sales", "ceo", ["tool:read", "tool:write", "delegate:sales/*", `path:rw:${workspace}/**`, ...(options.salesGrants ?? [])], options.salesSecrets);
	store.addUnit(parseManifest(salesRaw));
	// Root-owned stand-in: outside every rw grant of the unit.
	const manifestPath = join(real, "sales.unit.json");
	writeFileSync(manifestPath, JSON.stringify(salesRaw));
	// sales-eu: a descendant (not part of the sales manifest file).
	store.addUnit(man("sales-eu", "sales/eu", "sales", ["tool:read", `path:rw:${workspace}/eu/**`]));

	const registry = new PeerRegistry();
	const token = registry.issueToken("sales");
	const server = new ControlServer({ store, auth: registry });
	const socketPath = join(real, "c.sock");
	await server.listen(socketPath);

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: faux.getModel().id };

	return {
		root: real,
		workspace,
		outside,
		manifestPath,
		store,
		socketPath,
		token,
		faux,
		models,
		model,
		async dispatch(taskBudget: Budget = { tokens: 500_000, costUsd: 500, wallClockSec: 500_000 }) {
			const d = store.delegate({ fromUnit: "ceo", toUnit: "sales", goal: "write the summary", contract: CONTRACT, budget: taskBudget });
			if (!d.ok) throw new Error(`delegate failed: ${d.reason}`);
			const specs: WorkerSpec[] = [];
			const dispatcher = new Dispatcher({
				store,
				socketPath,
				workerMode: "durable",
				workspaceOf: () => workspace,
				durableDirOf: () => join(real, "durable"),
				tokenOf: () => token,
				spawner: (s) => void specs.push(s),
			});
			await dispatcher.tick();
			const spec = specs.find((s) => s.task.id === d.taskId);
			if (!spec) throw new Error("task was not dispatched");
			return { ...spec, env: { ...spec.env, ORG_UNIT_MANIFEST: manifestPath } };
		},
		async cleanup() {
			await server.close();
			store.close();
			rmSync(real, { recursive: true, force: true });
		},
	};
}

export function writeWorkspaceFile(dir: string, name: string, content: string): string {
	const p = join(dir, name);
	writeFileSync(p, content);
	return p;
}
