import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { getClient } from "./client.js";
import { missingCredential, parseUnipileConfig } from "./config.js";
import { attachLog } from "./log.js";
import { createRateLimiter } from "./rateLimit/index.js";
import { describeTier } from "./rateLimit/categories.js";
import { registerAllTools } from "./tools/index.js";

const PLUGIN_ID = "openclaw-unipile";

const plugin: OpenClawPluginDefinition = {
  id: PLUGIN_ID,
  name: "Unipile LinkedIn",
  description:
    "LinkedIn automation via Unipile (messaging, connections, profile, Sales Navigator search) with hard-enforced daily quotas and human-like pacing.",

  /**
   * Config reload policy. The rate limiter, tool descriptions, and Unipile
   * client are all seeded at register() time, so changes to credentials or
   * account identity need a full restart. Pacing / limits / working hours
   * are read on each gate() call — they hot-reload naturally once the host
   * re-enters register(), with no client reconnection.
   */
  reload: {
    restartPrefixes: ["dsn", "apiKey", "accountId", "accountTier", "enabled"],
    hotPrefixes: ["limits", "pacing", "workingHours", "telemetry", "debug"],
  },

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

    // Containerized hosts commonly run in UTC even when the operator thinks
    // in a local zone. Flag it early so "09:00–18:00 in system TZ" silent
    // misconfig doesn't show up as "writes only happen overnight in PST".
    if (cfg.workingHours.timezone === "system") {
      const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown";
      if (hostTz !== "UTC") {
        log.warn(
          `workingHours.timezone='system' and host TZ is '${hostTz}'. Set workingHours.timezone to an explicit IANA string if this isn't what you want.`,
        );
      }
    }

    const client = getClient(cfg);
    const limiter = createRateLimiter(cfg, log);

    const toolCount = registerAllTools(api, cfg, client, limiter, log);

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

    // /linkedin slash command — bypasses the LLM, returns a one-screen status
    // snapshot so an operator can see where the account stands without
    // burning an agent turn. Useful before approving a batch or debugging
    // why writes are blocked.
    api.registerCommand({
      name: "linkedin",
      description: "Show a compact Unipile LinkedIn usage snapshot for the connected account.",
      acceptsArgs: false,
      handler: () => {
        const report = limiter.report({ eventLimit: 0 });
        const wh = report.workingHours;
        const lines: string[] = [];
        lines.push(`LinkedIn (${cfg.accountId}, ${describeTier(cfg.accountTier)})`);
        lines.push(
          `Working hours: ${wh.ok ? "open" : "closed"} (${wh.window})` +
            (wh.nextOkAt ? ` — next open ${wh.nextOkAt}` : ""),
        );
        for (const [name, cat] of Object.entries(report.categories)) {
          const w = cat.week.limit !== null ? `, week ${cat.week.remaining}/${cat.week.limit}` : "";
          const m =
            cat.month.limit !== null ? `, month ${cat.month.remaining}/${cat.month.limit}` : "";
          const pacing = cat.spacingReadyAt ? ` — spacing clears ${cat.spacingReadyAt}` : "";
          lines.push(`${name}: today ${cat.today.remaining}/${cat.today.limit}${w}${m}${pacing}`);
        }
        return { text: lines.join("\n") };
      },
    });

    log.info(
      `ready — ${toolCount} tools registered for account ${cfg.accountId} ` +
        `(${describeTier(cfg.accountTier)}, working hours ${cfg.workingHours.start}-${cfg.workingHours.end} ${cfg.workingHours.timezone})`,
    );
  },
};

export default plugin;
