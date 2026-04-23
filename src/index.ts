import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { getClient } from "./client.js";
import { missingCredential, parseUnipileConfig } from "./config.js";
import { attachLog } from "./log.js";
import { createRateLimiter } from "./rateLimit/index.js";
import { describeTier } from "./rateLimit/categories.js";
import { registerAllTools, TOOL_COUNT } from "./tools/index.js";

const PLUGIN_ID = "openclaw-unipile";

const plugin: OpenClawPluginDefinition = {
  id: PLUGIN_ID,
  name: "Unipile LinkedIn",
  description:
    "LinkedIn automation via Unipile (messaging, connections, profile, Sales Navigator search) with hard-enforced daily quotas and human-like pacing.",

  register(api: OpenClawPluginApi): void {
    const cfg = parseUnipileConfig(api.pluginConfig);
    const log = attachLog(api.logger, cfg.debug);

    if (!cfg.enabled) {
      log.debug("plugin disabled");
      return;
    }

    const missing = missingCredential(cfg);
    if (missing) {
      log.warn(`missing ${missing} — LinkedIn tools will not be registered`);
      return;
    }

    const client = getClient(cfg);
    const limiter = createRateLimiter(cfg, log);

    registerAllTools(api, cfg, client, limiter, log);

    api.registerService({
      id: PLUGIN_ID,
      start: () => {
        // No-op: tools are ready as soon as register() completes.
      },
      stop: () => {
        log.info("service stop — flushing usage counters");
        limiter.flush();
      },
    });

    log.info(
      `ready — ${TOOL_COUNT} tools registered for account ${cfg.accountId} ` +
        `(${describeTier(cfg.accountTier)}, working hours ${cfg.workingHours.start}-${cfg.workingHours.end} ${cfg.workingHours.timezone})`,
    );
  },
};

export default plugin;
