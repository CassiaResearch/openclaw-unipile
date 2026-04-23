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

    // /linkedin-usage — detailed per-category usage with real `calls` vs.
    // 429/500 `penalty` split, in-flight reservations, spacing countdowns,
    // and polling cooldowns. More verbose than /linkedin; when you need
    // numbers to reason about.
    api.registerCommand({
      name: "linkedin-usage",
      description:
        "Detailed Unipile LinkedIn usage — per-category calls/penalty, limits, cooldowns.",
      acceptsArgs: false,
      handler: () => {
        const report = limiter.report({ eventLimit: 0 });
        const wh = report.workingHours;
        const lines: string[] = [];
        lines.push(`LinkedIn usage — ${cfg.accountId} (${describeTier(cfg.accountTier)})`);
        lines.push(
          `Working hours: ${wh.ok ? "open" : "closed"} (${wh.window})` +
            (wh.nextOkAt ? `, next open ${wh.nextOkAt}` : ""),
        );
        lines.push("");
        for (const [name, cat] of Object.entries(report.categories)) {
          lines.push(`[${name}]`);
          const renderWindow = (
            label: string,
            used: { calls: number; penalty: number },
            limit: number | null,
            remaining: number | null,
          ): string => {
            const total = used.calls + used.penalty;
            const penaltyStr = used.penalty > 0 ? ` (+${used.penalty} penalty)` : "";
            const base = `${label}: ${total}${penaltyStr}`;
            if (limit === null || remaining === null) return `${base} / —`;
            return `${base} / ${limit} (${remaining} left)`;
          };
          lines.push(
            "  " + renderWindow("today", cat.today.used, cat.today.limit, cat.today.remaining),
          );
          lines.push(
            "  " + renderWindow("week ", cat.week.used, cat.week.limit, cat.week.remaining),
          );
          lines.push(
            "  " + renderWindow("month", cat.month.used, cat.month.limit, cat.month.remaining),
          );
          if (cat.inFlight > 0) lines.push(`  in-flight: ${cat.inFlight}`);
          if (cat.spacingReadyAt) {
            lines.push(
              `  spacing: ${cat.secondsUntilSpacingCleared}s remaining (clears ${cat.spacingReadyAt})`,
            );
          }
        }
        if (Object.keys(report.cooldowns).length > 0) {
          lines.push("");
          lines.push("Cooldowns:");
          for (const [key, cd] of Object.entries(report.cooldowns)) {
            if (cd.secondsRemaining > 0) {
              lines.push(`  ${key}: ${cd.secondsRemaining}s remaining (clears ${cd.readyAt})`);
            } else {
              lines.push(`  ${key}: ready`);
            }
          }
        }
        return { text: lines.join("\n") };
      },
    });

    // /linkedin-events [N] — dumps the N most recent usage events from the
    // ring (default 20, max 500). Each event shows the tool, category,
    // result (ok / blocked / error / indeterminate), and any reason text.
    // Useful for reconstructing what just happened without tailing logs.
    api.registerCommand({
      name: "linkedin-events",
      description:
        "Show the N most recent Unipile LinkedIn usage events (default 20, max 500). Usage: /linkedin-events [N]",
      acceptsArgs: true,
      handler: (ctx) => {
        const requested = Number.parseInt((ctx.args ?? "").trim(), 10);
        const eventLimit =
          Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 20;
        const report = limiter.report({ eventLimit });
        if (report.recentEvents.length === 0) {
          return { text: "No recent LinkedIn usage events on record." };
        }
        const lines: string[] = [];
        lines.push(`LinkedIn recent events (${report.recentEvents.length} of ring):`);
        for (const e of report.recentEvents) {
          const dur = e.durationMs !== undefined ? ` ${e.durationMs}ms` : "";
          const status = e.errorStatus !== undefined ? ` http=${e.errorStatus}` : "";
          const reason = e.reason ? ` — ${e.reason}` : "";
          lines.push(
            `${e.t} ${e.tool} [${e.cat} cost=${e.cost}] → ${e.result}${dur}${status}${reason}`,
          );
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
