/** Model selection for the worker bin: provider/model ids from the environment, auth via pi-ai's usual provider env keys. */

import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelRef } from "@earendil-works/pi-durable";

export const ENV_DURABLE_PROVIDER = "ORG_DURABLE_PROVIDER";
export const ENV_DURABLE_MODEL = "ORG_DURABLE_MODEL";

export function modelFromEnv(env: Record<string, string | undefined>): ModelRef {
	const provider = env[ENV_DURABLE_PROVIDER];
	const modelId = env[ENV_DURABLE_MODEL];
	if (!provider || !modelId) throw new Error(`${ENV_DURABLE_PROVIDER} and ${ENV_DURABLE_MODEL} are required`);
	return { provider, modelId };
}

/** Every built-in pi-ai provider registered; providers authenticate from their own env vars. */
export function modelsFromEnv(_env: Record<string, string | undefined>): Models {
	return builtinModels();
}
