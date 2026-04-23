import { UnipileConfigSchema } from "./configSchema.js";
import type { Log } from "./log.js";
import type { UnipileConfig } from "./types.js";

/**
 * Parse plugin config into a fully-populated UnipileConfig, applying
 * defaults, coercing `"true"`/`"1"`/etc. for booleans, and filling
 * credentials from env when unset. On schema violation (bad number ranges,
 * invalid HH:MM, bad accountTier) we log each issue and fall back to
 * defaults — the host still runs, `missingCredential` just trips and tools
 * won't be registered.
 */
export function parseUnipileConfig(value: unknown, log?: Log): UnipileConfig {
  // Host may pass undefined / null / non-object on first boot before config
  // is populated. Treat it as empty so the schema defaults fire.
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = UnipileConfigSchema.safeParse(input);
  if (result.success) return result.data;

  if (log) {
    for (const issue of result.error.issues) {
      log.warn(`config: ${issue.path.join(".") || "(root)"} ${issue.message} — using default`);
    }
  }
  // Fallback: parse an empty object so defaults fill in what we can. If the
  // empty-object parse also fails (it shouldn't — defaults cover everything
  // except credentials), cast a minimal struct.
  const fallback = UnipileConfigSchema.safeParse({});
  if (fallback.success) return fallback.data;
  throw new Error("unipile config schema rejects {} — schema is broken");
}

export function missingCredential(cfg: UnipileConfig): string | null {
  if (!cfg.dsn) return "dsn (set UNIPILE_DSN or config.dsn)";
  if (!cfg.apiKey) return "apiKey (set UNIPILE_API_KEY or config.apiKey)";
  if (!cfg.accountId) return "accountId (set UNIPILE_ACCOUNT_ID or config.accountId)";
  return null;
}
