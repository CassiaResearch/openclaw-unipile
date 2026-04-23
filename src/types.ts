import type { z } from "openclaw/plugin-sdk/zod";
import type { UnipileConfigSchema } from "./configSchema.js";

/**
 * Shared runtime types for the plugin. Most config-shape types are inferred
 * directly from the Zod schema so we have one source of truth.
 */

export type UnipileConfig = z.infer<typeof UnipileConfigSchema>;
export type AccountTier = UnipileConfig["accountTier"];
export type UnipileLimits = UnipileConfig["limits"];
export type UnipilePacing = UnipileConfig["pacing"];
export type UnipileWorkingHours = UnipileConfig["workingHours"];
export type UnipileTelemetry = UnipileConfig["telemetry"];
export type Weekday = UnipileWorkingHours["days"][number];

export type RateCategory =
  | "invitation_write"
  | "profile_read"
  | "search_results"
  | "message_write"
  | "relation_poll"
  | "default"
  | "cached_read";
