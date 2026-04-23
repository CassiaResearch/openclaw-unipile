import type { AccountTier, RateCategory, UnipileConfig } from "../types.js";

export const CATEGORIES: readonly RateCategory[] = [
  "invitation_write",
  "message_write",
  "profile_read",
  "search_results",
  "relation_poll",
  "default",
  "cached_read",
];

export interface CategoryRule {
  dailyLimit: number;
  weeklyLimit?: number;
  monthlyLimit?: number;
  minSpacingSec: number;
  cooldownSec: number;
  workingHoursOnly: boolean;
  // When true, calls in this category do not pass through the rate limiter at
  // all — no mutex, no gate, no jitter, no usage tracking. Use only for
  // endpoints that never hit the provider (e.g. Unipile-cached chat reads).
  bypassAll: boolean;
  // When true, calls are serialized through the limiter's mutex. Typically
  // only writes, where concurrent calls from a single account are the primary
  // bot-detection signal.
  serializeCalls: boolean;
}

export function resolveCategoryRules(cfg: UnipileConfig): Record<RateCategory, CategoryRule> {
  const salesLike = cfg.accountTier === "sales_navigator" || cfg.accountTier === "recruiter";

  return {
    invitation_write: {
      dailyLimit: cfg.limits.invitationsPerDay,
      weeklyLimit: cfg.limits.invitationsPerWeek,
      monthlyLimit: cfg.limits.invitationsPerMonth,
      minSpacingSec: cfg.pacing.invitationMinSpacingSec,
      cooldownSec: 0,
      workingHoursOnly: true,
      bypassAll: false,
      serializeCalls: true,
    },
    message_write: {
      dailyLimit: cfg.limits.messagesPerDay,
      monthlyLimit: cfg.limits.messagesPerMonth,
      minSpacingSec: 0,
      cooldownSec: 0,
      workingHoursOnly: true,
      bypassAll: false,
      serializeCalls: true,
    },
    profile_read: {
      dailyLimit: salesLike ? cfg.limits.profileReadsPerDay * 2 : cfg.limits.profileReadsPerDay,
      monthlyLimit: cfg.limits.profileReadsPerMonth,
      minSpacingSec: 0,
      cooldownSec: 0,
      workingHoursOnly: false,
      bypassAll: false,
      serializeCalls: false,
    },
    search_results: {
      dailyLimit: salesLike
        ? cfg.limits.searchResultsPerDay
        : Math.min(cfg.limits.searchResultsPerDay, 1000),
      monthlyLimit: cfg.limits.searchResultsPerMonth,
      minSpacingSec: 0,
      cooldownSec: 0,
      workingHoursOnly: false,
      bypassAll: false,
      serializeCalls: false,
    },
    relation_poll: {
      dailyLimit: cfg.limits.defaultPerDay,
      monthlyLimit: cfg.limits.defaultPerMonth,
      minSpacingSec: 0,
      cooldownSec: cfg.pacing.pollingCooldownHours * 3600,
      workingHoursOnly: false,
      bypassAll: false,
      serializeCalls: false,
    },
    default: {
      dailyLimit: cfg.limits.defaultPerDay,
      monthlyLimit: cfg.limits.defaultPerMonth,
      minSpacingSec: 0,
      cooldownSec: 0,
      workingHoursOnly: false,
      bypassAll: false,
      serializeCalls: false,
    },
    cached_read: {
      dailyLimit: Number.POSITIVE_INFINITY,
      minSpacingSec: 0,
      cooldownSec: 0,
      workingHoursOnly: false,
      bypassAll: true,
      serializeCalls: false,
    },
  };
}

export function describeTier(tier: AccountTier): string {
  switch (tier) {
    case "sales_navigator":
      return "Sales Navigator";
    case "recruiter":
      return "Recruiter";
    default:
      return "Classic";
  }
}
