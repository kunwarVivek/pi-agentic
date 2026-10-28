/**
 * Child process for the crash/restart test: runs the durable worker with a
 * scripted model whose second request kills the process with SIGKILL, after the
 * first step's tool call has been committed to the task's SQLite storage.
 */

import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { runDurableTask } from "../../src/index.ts";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const killNow = () => {
	process.kill(process.pid, "SIGKILL");
	return fauxAssistantMessage("unreachable");
};
// CRASH_FIRST_REQUEST=1: die on the very first model request (a continuation run).
if (process.env.CRASH_FIRST_REQUEST === "1") faux.setResponses([killNow]);
else faux.setResponses([
	fauxAssistantMessage([fauxToolCall("read", { path: process.env.CRASH_READ_PATH ?? "" })], { stopReason: "toolUse" }),
	killNow,
]);

await runDurableTask({
	env: process.env,
	models,
	model: { provider: "faux", modelId: faux.getModel().id },
	cwd: process.env.CRASH_CWD ?? process.cwd(),
});
