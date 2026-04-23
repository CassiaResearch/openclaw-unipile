import type {
  AccountTier,
  UnipileConfig,
  UnipileLimits,
  UnipilePacing,
  UnipileTelemetry,
  UnipileWorkingHours,
  Weekday,
} from "./types.js";

const DEFAULT_LIMITS: UnipileLimits = {
  invitationsPerDay: 80,
  invitationsPerWeek: 200,
  invitationsPerMonth: 600,
  profileReadsPerDay: 100,
  profileReadsPerMonth: 3000,
  searchResultsPerDay: 2500,
  searchResultsPerMonth: 50000,
  messagesPerDay: 100,
  messagesPerMonth: 2000,
  defaultPerDay: 100,
  defaultPerMonth: 2000,
};

const DEFAULT_PACING: UnipilePacing = {
  jitterMinMs: 400,
  jitterMaxMs: 1500,
  invitationMinSpacingSec: 90,
  pollingCooldownHours: 4,
};

const DEFAULT_TELEMETRY: UnipileTelemetry = {
  eventRingSize: 500,
};

const DEFAULT_WORKING_HOURS: UnipileWorkingHours = {
  start: "09:00",
  end: "18:00",
  timezone: "system",
  days: ["mon", "tue", "wed", "thu", "fri"],
};

const WEEKDAYS: ReadonlySet<Weekday> = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function pick(raw: Record<string, unknown>, key: string, envVar: string): string {
  return asString(raw[key]) || asString(process.env[envVar]) || "";
}

/**
 * Overlay caller-provided fields on top of `defaults`. The JSON schema in
 * openclaw.plugin.json already validates types upstream, so this trusts the
 * input shape — it only guards against `value` being null/non-object/array.
 */
function mergeObject<T extends object>(defaults: T, value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...defaults };
  }
  return { ...defaults, ...(value as Partial<T>) };
}

function parseTier(value: unknown): AccountTier {
  const s = asString(value);
  return s === "classic" || s === "sales_navigator" || s === "recruiter" ? s : "sales_navigator";
}

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return fallback;
}

function parseWeekdays(value: unknown): Weekday[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is Weekday => WEEKDAYS.has(v as Weekday));
  return out.length > 0 ? Array.from(new Set(out)) : undefined;
}

export function parseUnipileConfig(value: unknown): UnipileConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const rawWorkingHours = raw.workingHours;
  const workingHoursBase = mergeObject<UnipileWorkingHours>(DEFAULT_WORKING_HOURS, rawWorkingHours);
  const daysFromRaw =
    rawWorkingHours && typeof rawWorkingHours === "object" && !Array.isArray(rawWorkingHours)
      ? parseWeekdays((rawWorkingHours as Record<string, unknown>).days)
      : undefined;

  return {
    enabled: parseBool(raw.enabled, true),
    dsn: pick(raw, "dsn", "UNIPILE_DSN"),
    apiKey: pick(raw, "apiKey", "UNIPILE_API_KEY"),
    accountId: pick(raw, "accountId", "UNIPILE_ACCOUNT_ID"),
    accountTier: parseTier(raw.accountTier),
    limits: mergeObject<UnipileLimits>(DEFAULT_LIMITS, raw.limits),
    pacing: mergeObject<UnipilePacing>(DEFAULT_PACING, raw.pacing),
    workingHours: {
      ...workingHoursBase,
      days: daysFromRaw ?? DEFAULT_WORKING_HOURS.days,
    },
    telemetry: mergeObject<UnipileTelemetry>(DEFAULT_TELEMETRY, raw.telemetry),
    debug: parseBool(raw.debug, false),
  };
}

export function missingCredential(cfg: UnipileConfig): string | null {
  if (!cfg.dsn) return "dsn (set UNIPILE_DSN or config.dsn)";
  if (!cfg.apiKey) return "apiKey (set UNIPILE_API_KEY or config.apiKey)";
  if (!cfg.accountId) return "accountId (set UNIPILE_ACCOUNT_ID or config.accountId)";
  return null;
}
