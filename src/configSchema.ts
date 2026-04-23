import { z } from "openclaw/plugin-sdk/zod";

/**
 * Zod schema — the runtime source of truth for plugin configuration.
 *
 * Mirrors the JSON Schema block in openclaw.plugin.json (the loader needs
 * that one before any runtime code is reached). Keep the two in sync; when
 * they diverge, Zod wins at register() time and the manifest JSON is only
 * used for the setup wizard / config UI scaffolding.
 *
 * We trim strings and apply sensible defaults so an empty `{}` passed in
 * from the host round-trips to a fully-populated UnipileConfig — matching
 * the old hand-rolled parseUnipileConfig behavior.
 */

const WeekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const HHMMSchema = z
  .string()
  .regex(/^\d{1,2}:\d{2}$/, "must be HH:MM in 24-hour form")
  .refine(
    (s) => {
      const [h, m] = s.split(":").map((n) => Number(n));
      return h !== undefined && m !== undefined && h >= 0 && h <= 23 && m >= 0 && m <= 59;
    },
    { message: "hour must be 0–23 and minute 0–59" },
  );

const LimitsSchema = z
  .object({
    invitationsPerDay: z.number().int().min(1).max(200).default(80),
    invitationsPerWeek: z.number().int().min(1).max(1000).default(200),
    invitationsPerMonth: z.number().int().min(1).max(3000).default(600),
    profileReadsPerDay: z.number().int().min(1).max(2000).default(100),
    profileReadsPerMonth: z.number().int().min(1).max(100000).default(3000),
    searchResultsPerDay: z.number().int().min(1).max(5000).default(2500),
    searchResultsPerMonth: z.number().int().min(1).max(1000000).default(50000),
    messagesPerDay: z.number().int().min(1).max(500).default(100),
    messagesPerMonth: z.number().int().min(1).max(50000).default(2000),
    defaultPerDay: z.number().int().min(1).max(500).default(100),
    defaultPerMonth: z.number().int().min(1).max(50000).default(2000),
  })
  .prefault({});

const PacingSchema = z
  .object({
    jitterMinMs: z.number().int().min(0).default(400),
    jitterMaxMs: z.number().int().min(0).default(1500),
    invitationMinSpacingSec: z.number().int().min(0).default(90),
    pollingCooldownHours: z.number().int().min(0).default(4),
  })
  .prefault({});

const TelemetrySchema = z
  .object({
    eventRingSize: z.number().int().min(0).max(5000).default(500),
  })
  .prefault({});

const WorkingHoursSchema = z
  .object({
    start: HHMMSchema.default("09:00"),
    end: HHMMSchema.default("18:00"),
    timezone: z.string().default("system"),
    days: z
      .array(WeekdaySchema)
      // Dedupe while preserving order — config UIs may emit duplicates from
      // checkbox toggles.
      .transform((arr) => Array.from(new Set(arr)))
      .default(["mon", "tue", "wed", "thu", "fri"]),
  })
  .prefault({});

/**
 * Accepts `true` / `false` / `"true"` / `"false"` / `"1"` / `"0"` / `"yes"` /
 * `"no"`. Matches legacy parseBool behavior so env-sourced string booleans
 * still work.
 */
const FlexibleBoolean = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return v;
}, z.boolean());

/**
 * String field that trims whitespace and falls back to an env var when the
 * trimmed value is empty. Used for credentials that can come from either
 * plugin config or environment. Resolves to "" when neither is set —
 * missingCredential() surfaces that to the caller.
 */
function envFallbackString(envVar: string) {
  return z.preprocess((v) => {
    const raw = typeof v === "string" ? v.trim() : "";
    if (raw) return raw;
    const env = process.env[envVar];
    return typeof env === "string" ? env.trim() : "";
  }, z.string());
}

export const UnipileConfigSchema = z.object({
  enabled: FlexibleBoolean.default(true),
  dsn: envFallbackString("UNIPILE_DSN"),
  apiKey: envFallbackString("UNIPILE_API_KEY"),
  accountId: envFallbackString("UNIPILE_ACCOUNT_ID"),
  accountTier: z.enum(["classic", "sales_navigator", "recruiter"]).default("sales_navigator"),
  limits: LimitsSchema,
  pacing: PacingSchema,
  workingHours: WorkingHoursSchema,
  telemetry: TelemetrySchema,
  debug: FlexibleBoolean.default(false),
});

export type UnipileConfigParsed = z.infer<typeof UnipileConfigSchema>;
