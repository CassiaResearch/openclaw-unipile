import { UnipileLimitError, inspectError, isRatePenalty } from "../errors.js";
import type { Log } from "../log.js";
import type { RateCategory, UnipileConfig } from "../types.js";
import { CATEGORIES, resolveCategoryRules, type CategoryRule } from "./categories.js";
export type { CategoryRule } from "./categories.js";
import { AsyncMutex } from "./mutex.js";
import {
  checkWorkingHours,
  cooldownRemainingSec,
  formatSeconds,
  jitter,
  minSpacingRemainingSec,
} from "./pacing.js";
import {
  addCategoryCount,
  addToolCount,
  hasDedupHash,
  loadUsage,
  nowIso,
  pushDedupHash,
  pushEvent,
  readIsoAsMs,
  saveUsage,
  sumCategoryAcrossDates,
  todayUtc,
  type UsageEvent,
  type UsageState,
} from "./storage.js";

const PENALTY_MULTIPLIER = 5;
const PENALTY_SPACING_BONUS_SEC = 120;
const PERSIST_DEBOUNCE_MS = 1000;

export interface GateOptions {
  toolName: string;
  category: RateCategory;
  cost?: number;
  cooldownKey?: string;
}

export interface RecordSuccessOptions {
  toolName: string;
  category: RateCategory;
  cost?: number;
  cooldownKey?: string;
  durationMs?: number;
  /**
   * When true, the call is counted against budget (the write probably landed
   * on LinkedIn) but recorded as an "indeterminate" event so downstream
   * observers know the outcome wasn't confirmed. Used for Unipile timeouts
   * on write categories — see isIndeterminateSend in errors.ts.
   */
  indeterminate?: boolean;
}

export interface RecordFailureOptions {
  toolName: string;
  category: RateCategory;
  cooldownKey?: string;
  durationMs?: number;
  err: unknown;
}

export interface WindowUsage {
  calls: number;
  penalty: number;
}

export interface CategoryUsageReport {
  today: { used: WindowUsage; limit: number; remaining: number };
  week: { used: WindowUsage; limit: number | null; remaining: number | null };
  month: { used: WindowUsage; limit: number | null; remaining: number | null };
  minSpacingSec: number;
  secondsUntilSpacingCleared: number;
  workingHoursOnly: boolean;
  serializeCalls: boolean;
}

export interface UsageReport {
  generatedAt: string;
  accountId: string;
  accountTier: string;
  workingHours: { ok: boolean; window: string };
  categories: Record<string, CategoryUsageReport>;
  cooldowns: Record<string, { cooldownSec: number; secondsRemaining: number }>;
  perToolToday: Record<string, number>;
  recentEvents: UsageEvent[];
}

export interface RateLimiter {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  getRule(category: RateCategory): CategoryRule;
  gate(opts: GateOptions): Promise<void>;
  recordSuccess(opts: RecordSuccessOptions): void;
  recordFailure(opts: RecordFailureOptions): void;
  /** Logs a non-gate block (e.g. dedup) as a "blocked" event. */
  recordBlocked(opts: { toolName: string; category: RateCategory; reason: string }): void;
  isDuplicateSend(key: string, text: string): boolean;
  recordSend(key: string, text: string): void;
  report(opts?: { eventLimit?: number }): UsageReport;
  flush(): void;
}

function windowTotal(w: WindowUsage): number {
  return w.calls + w.penalty;
}

export function createRateLimiter(cfg: UnipileConfig, log: Log): RateLimiter {
  const rules = resolveCategoryRules(cfg);
  const state: UsageState = loadUsage(cfg.accountId, {
    accountTier: cfg.accountTier,
    onCorruption: (err) => {
      log.warn(
        `usage.json is unreadable (${err instanceof Error ? err.message : String(err)}). Starting with a fresh counter — prior usage history is lost.`,
      );
    },
  });
  // Keep the tier in sync if the user changed it between sessions.
  state.accountTier = cfg.accountTier;

  const mutex = new AsyncMutex();
  let pendingPersist: ReturnType<typeof setTimeout> | null = null;

  function persistNow(): void {
    if (pendingPersist) {
      clearTimeout(pendingPersist);
      pendingPersist = null;
    }
    try {
      saveUsage(cfg.accountId, state);
    } catch (err) {
      log.warn(`failed to persist usage: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function schedulePersist(): void {
    if (pendingPersist) return;
    pendingPersist = setTimeout(() => {
      pendingPersist = null;
      persistNow();
    }, PERSIST_DEBOUNCE_MS);
    (pendingPersist as unknown as { unref?: () => void }).unref?.();
  }

  function blockingReason(
    category: RateCategory,
    rule: CategoryRule,
    cost: number,
    cooldownKey: string,
  ): string | null {
    if (rule.workingHoursOnly) {
      const wh = checkWorkingHours(cfg.workingHours, log);
      if (!wh.ok) {
        return `Outside working hours (${wh.windowLabel}). Writes are paused until the next window.`;
      }
    }

    const label = category.replace("_", " ");

    const daily = windowTotal(sumCategoryAcrossDates(state, category, 1));
    if (daily + cost > rule.dailyLimit) {
      const reset = new Date();
      reset.setUTCHours(24, 0, 0, 0);
      return `Daily ${label} budget exhausted: ${daily}/${rule.dailyLimit} used today (cost ${cost}). Resets at ${reset.toISOString()}.`;
    }

    if (rule.weeklyLimit !== undefined) {
      const weekly = windowTotal(sumCategoryAcrossDates(state, category, 7));
      if (weekly + cost > rule.weeklyLimit) {
        return `Weekly ${label} budget exhausted: ${weekly}/${rule.weeklyLimit} used in the last 7 days (cost ${cost}). Resets as old usage ages out — retry tomorrow.`;
      }
    }

    if (rule.monthlyLimit !== undefined) {
      const monthly = windowTotal(sumCategoryAcrossDates(state, category, 30));
      if (monthly + cost > rule.monthlyLimit) {
        return `Monthly ${label} budget exhausted: ${monthly}/${rule.monthlyLimit} used in the last 30 days (cost ${cost}). Resets as old usage ages out.`;
      }
    }

    const spacingLeft = minSpacingRemainingSec(
      readIsoAsMs(state.lastCallAt[category]),
      rule.minSpacingSec,
    );
    if (spacingLeft > 0) {
      return `Minimum spacing for ${label}: wait ${formatSeconds(spacingLeft)} before the next call.`;
    }

    const cooldownLeft = cooldownRemainingSec(
      readIsoAsMs(state.lastCooldownAt[cooldownKey]),
      rule.cooldownSec,
    );
    if (cooldownLeft > 0) {
      return `Polling cooldown active for ${cooldownKey}: wait ${formatSeconds(cooldownLeft)} before the next call.`;
    }

    return null;
  }

  function recordEvent(event: UsageEvent): void {
    pushEvent(state, event, cfg.telemetry.eventRingSize);
  }

  function buildReport(opts: { eventLimit?: number } = {}): UsageReport {
    const wh = checkWorkingHours(cfg.workingHours, log);
    const categories: Record<string, CategoryUsageReport> = {};
    const today = todayUtc();

    for (const cat of CATEGORIES) {
      const rule = rules[cat];
      if (rule.bypassAll) continue;
      const day = sumCategoryAcrossDates(state, cat, 1);
      const week = sumCategoryAcrossDates(state, cat, 7);
      const month = sumCategoryAcrossDates(state, cat, 30);
      categories[cat] = {
        today: {
          used: day,
          limit: rule.dailyLimit,
          remaining: Math.max(0, rule.dailyLimit - windowTotal(day)),
        },
        week: {
          used: week,
          limit: rule.weeklyLimit ?? null,
          remaining:
            rule.weeklyLimit === undefined
              ? null
              : Math.max(0, rule.weeklyLimit - windowTotal(week)),
        },
        month: {
          used: month,
          limit: rule.monthlyLimit ?? null,
          remaining:
            rule.monthlyLimit === undefined
              ? null
              : Math.max(0, rule.monthlyLimit - windowTotal(month)),
        },
        minSpacingSec: rule.minSpacingSec,
        secondsUntilSpacingCleared: minSpacingRemainingSec(
          readIsoAsMs(state.lastCallAt[cat]),
          rule.minSpacingSec,
        ),
        workingHoursOnly: rule.workingHoursOnly,
        serializeCalls: rule.serializeCalls,
      };
    }

    const pollCooldownSec = rules.relation_poll.cooldownSec;
    const cooldowns: Record<string, { cooldownSec: number; secondsRemaining: number }> = {};
    for (const key of Object.keys(state.lastCooldownAt)) {
      cooldowns[key] = {
        cooldownSec: pollCooldownSec,
        secondsRemaining: cooldownRemainingSec(
          readIsoAsMs(state.lastCooldownAt[key]),
          pollCooldownSec,
        ),
      };
    }

    const eventLimit = Math.max(0, opts.eventLimit ?? 20);
    return {
      generatedAt: nowIso(),
      accountId: cfg.accountId,
      accountTier: cfg.accountTier,
      workingHours: { ok: wh.ok, window: wh.windowLabel },
      categories,
      cooldowns,
      perToolToday: { ...(state.aggregates.perTool[today] ?? {}) },
      recentEvents: state.events.slice(0, eventLimit),
    };
  }

  return {
    runExclusive: (fn) => mutex.runExclusive(fn),

    getRule: (category) => rules[category],

    async gate({ toolName, category, cost = 1, cooldownKey }) {
      const rule = rules[category];
      const key = cooldownKey ?? category;
      const reason = blockingReason(category, rule, cost, key);
      if (reason) {
        recordEvent({
          t: nowIso(),
          tool: toolName,
          cat: category,
          cost,
          result: "blocked",
          reason,
        });
        schedulePersist();
        throw new UnipileLimitError(reason);
      }
      await jitter(cfg.pacing.jitterMinMs, cfg.pacing.jitterMaxMs);
    },

    recordSuccess({ toolName, category, cost = 1, cooldownKey, durationMs, indeterminate }) {
      const date = todayUtc();
      addCategoryCount(state, date, category, { calls: cost });
      addToolCount(state, date, toolName, 1);
      const iso = nowIso();
      state.lastCallAt[category] = iso;
      if (rules[category].cooldownSec > 0) {
        state.lastCooldownAt[cooldownKey ?? category] = iso;
      }
      const event: UsageEvent = {
        t: iso,
        tool: toolName,
        cat: category,
        cost,
        result: indeterminate ? "indeterminate" : "ok",
      };
      if (durationMs !== undefined) event.durationMs = durationMs;
      recordEvent(event);
      schedulePersist();
    },

    recordFailure({ toolName, category, cooldownKey, durationMs, err }) {
      const date = todayUtc();
      const iso = nowIso();
      const penalty = isRatePenalty(err);
      const { status } = inspectError(err);

      state.lastCallAt[category] = iso;
      if (penalty) {
        addCategoryCount(state, date, category, { penalty: PENALTY_MULTIPLIER });
        // Bump lastCallAt forward to force additional spacing after a rate hit.
        state.lastCallAt[category] = new Date(
          Date.now() + PENALTY_SPACING_BONUS_SEC * 1000,
        ).toISOString();
        if (rules[category].cooldownSec > 0) {
          state.lastCooldownAt[cooldownKey ?? category] = iso;
        }
      }

      const event: UsageEvent = {
        t: iso,
        tool: toolName,
        cat: category,
        cost: penalty ? PENALTY_MULTIPLIER : 0,
        result: "error",
      };
      if (durationMs !== undefined) event.durationMs = durationMs;
      if (status !== undefined) event.errorStatus = status;
      recordEvent(event);
      schedulePersist();
    },

    recordBlocked({ toolName, category, reason }) {
      recordEvent({
        t: nowIso(),
        tool: toolName,
        cat: category,
        cost: 0,
        result: "blocked",
        reason,
      });
      schedulePersist();
    },

    isDuplicateSend(key, text) {
      return hasDedupHash(state, key, text);
    },

    recordSend(key, text) {
      pushDedupHash(state, key, text);
      schedulePersist();
    },

    report(opts) {
      return buildReport(opts);
    },

    flush() {
      persistNow();
    },
  };
}
