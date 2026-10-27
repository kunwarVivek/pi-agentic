/**
 * agentic-pi org extension: the single default-export entry point that wires
 * the five org extensions (policy, delegate, context, trust, budget) onto a
 * shared control-plane runtime.
 *
 * Load in dev with: pi -e src/ext/index.ts
 * The extension is inert unless ORG_UNIT_ID and ORG_CONTROL_DB are set in the
 * environment (so a plain `pi -e` session is unaffected).
 */

import { bootstrap } from "./bootstrap.ts";
import { installOrgBudget } from "./org-budget.ts";
import { installOrgContext } from "./org-context.ts";
import { installOrgDelegate } from "./org-delegate.ts";
import { installOrgPolicy } from "./org-policy.ts";
import { installOrgTrust } from "./org-trust.ts";
import { nearestRealpath } from "./org-policy.ts";
import type { Extension, ExtensionAPI } from "./pi-api.ts";

const extension: Extension = (pi: ExtensionAPI) => {
	const runtime = bootstrap(pi);
	installOrgPolicy(pi, runtime);
	installOrgDelegate(pi, runtime);
	installOrgContext(pi, runtime);
	installOrgTrust(pi, runtime, nearestRealpath);
	installOrgBudget(pi, runtime);
};

export default extension;
