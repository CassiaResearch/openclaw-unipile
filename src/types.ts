export type AccountTier = "classic" | "sales_navigator" | "recruiter";

export interface UnipileLimits {
  invitationsPerDay: number;
  invitationsPerWeek: number;
  invitationsPerMonth: number;
  profileReadsPerDay: number;
  profileReadsPerMonth: number;
  searchResultsPerDay: number;
  searchResultsPerMonth: number;
  messagesPerDay: number;
  messagesPerMonth: number;
  defaultPerDay: number;
  defaultPerMonth: number;
}

export interface UnipilePacing {
  jitterMinMs: number;
  jitterMaxMs: number;
  invitationMinSpacingSec: number;
  pollingCooldownHours: number;
}

export interface UnipileTelemetry {
  eventRingSize: number;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface UnipileWorkingHours {
  start: string;
  end: string;
  timezone: string;
  days: Weekday[];
}

export interface UnipileConfig {
  enabled: boolean;
  dsn: string;
  apiKey: string;
  accountId: string;
  accountTier: AccountTier;
  limits: UnipileLimits;
  pacing: UnipilePacing;
  workingHours: UnipileWorkingHours;
  telemetry: UnipileTelemetry;
  debug: boolean;
}

export type RateCategory =
  | "invitation_write"
  | "profile_read"
  | "search_results"
  | "message_write"
  | "relation_poll"
  | "default"
  | "cached_read";
