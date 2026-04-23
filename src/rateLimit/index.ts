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
  nextWorkingHoursStart,
  sleep,
  sleepWithHeartbeat,
} from "./pacing.js";
import {
  addCategoryCount,
  addToolCount,
  archiveEvents,
  archiveOldDailyAggregates,
  loadUsage,
  nowIso,
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
const PERSIST_DEBOUNCE_MS = 10000;

/**
 * Partial-progress callback the tool receives from the agent harness. Matches
 * `AgentToolUpdateCallback` in the pi-agent-core SDK: a function taking an
 * `AgentToolResult`-shaped object. We declare a local structural type so this
 * package doesn't need to depend on pi-agent-core directly.
 */
export type ProgressUpdate = (partial: {
  content: { type: "text"; text: string }[];
  details?: unknown;
}) => void;

export interface GateOptions {
  toolName: string;
  category: RateCategory;
  cost?: number;
  cooldownKey?: string;
  /**
   * If a waitable block (spacing / polling cooldown) would otherwise fail the
   * call, `gate()` may sleep up to this many seconds and re-check instead of
   * throwing. Budget / working-hours blocks still throw immediately — those
   * waits are too long to sit on synchronously. Default 0 = legacy fail-fast.
   */
  waitUpToSec?: number;
  /**
   * Optional progress callback from the agent harness. When the gate sleeps
   * for a soft block, we emit heartbeat pings every ~10 s so the tool call
   * stays visible and the harness's per-tool timeout resets on each update.
   */
  onUpdate?: ProgressUpdate;
}

export interface RecordSuccessOptions {
  toolName: string;
  category: RateCategory;
  cost?: number;
  /**
   * The cost that was reserved at gate() time. Defaults to `cost`. Only
   * differs when the caller knows the true cost only after the call returns
   * (e.g. search_results, which charges per returned item). Used to release
   * the right amount of in-flight reservation.
   */
  reservedCost?: number;
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
  /** Reservation made at gate() time to release. Defaults to 1. */
  reservedCost?: number;
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
  inFlight: number;
  minSpacingSec: number;
  secondsUntilSpacingCleared: number;
  /** ISO time when spacing clears; null when no spacing is pending. */
  spacingReadyAt: string | null;
  workingHoursOnly: boolean;
  serializeCalls: boolean;
}

export interface UsageReport {
  generatedAt: string;
  accountId: string;
  accountTier: string;
  /** `nextOkAt` is null when currently in-window; otherwise ISO. */
  workingHours: { ok: boolean; window: string; nextOkAt: string | null };
  categories: Record<string, CategoryUsageReport>;
  cooldowns: Record<
    string,
    { cooldownSec: number; secondsRemaining: number; readyAt: string | null }
  >;
  perToolToday: Record<string, number>;
  recentEvents: UsageEvent[];
}

export interface AffordabilityCheck {
  /** True iff a call of `cost` would pass the gate right now (ignores jitter). */
  ok: boolean;
  /** Why it wouldn't pass, if !ok. Matches the format `gate()` would throw. */
  blockingReason: string | null;
  /**
   * Structured classification for the agent to branch on. Null when `ok`.
   * Same code space as the `errorCode` field on a tool result.
   */
  blockingCode: "working_hours" | "budget_exhausted" | "spacing" | "cooldown" | null;
  /**
   * Earliest time the call could be attempted. Null if currently ok.
   * Waitable blocks (spacing, cooldown) yield a near-term ISO. Hard blocks
   * (working hours, budget) yield the next boundary if known, else null.
   */
  retryAt: string | null;
  /** Per-window headroom after accounting for current usage and in-flight. */
  remaining: { today: number; week: number | null; month: number | null };
}

export interface CheckAffordabilityOptions {
  category: RateCategory;
  cost?: number;
  cooldownKey?: string;
}

export interface RateLimiter {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  getRule(category: RateCategory): CategoryRule;
  gate(opts: GateOptions): Promise<void>;
  recordSuccess(opts: RecordSuccessOptions): void;
  recordFailure(opts: RecordFailureOptions): void;
  /** Logs a non-gate block (e.g. dedup) as a "blocked" event. */
  recordBlocked(opts: { toolName: string; category: RateCategory; reason: string }): void;
  /** Pre-flight check: would a gate() call of this shape pass right now? */
  checkAffordability(opts: CheckAffordabilityOptions): AffordabilityCheck;
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

  // In-flight reservations made by gate() but not yet resolved by
  // recordSuccess/recordFailure. Included in budget checks so parallel reads
  // can't all pass the gate at the same instant and then collectively
  // overshoot the cap. Reset per process (not persisted — they only matter
  // for concurrent calls).
  const reserved: Partial<Record<RateCategory, number>> = {};

  const mutex = new AsyncMutex();
  let pendingPersist: ReturnType<typeof setTimeout> | null = null;
  const pendingArchiveEvents: UsageEvent[] = [];

  function persistNow(): void {
    if (pendingPersist) {
      clearTimeout(pendingPersist);
      pendingPersist = null;
    }
    try {
      const archivedDates = archiveOldDailyAggregates(cfg.accountId, state);
      if (archivedDates > 0) {
        log.debug(`archived ${archivedDates} day(s) of aggregates to usage-history.jsonl`);
      }
      if (pendingArchiveEvents.length > 0) {
        archiveEvents(cfg.accountId, pendingArchiveEvents);
        pendingArchiveEvents.length = 0;
      }
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

  function reservedFor(category: RateCategory): number {
    return reserved[category] ?? 0;
  }

  function addReservation(category: RateCategory, cost: number): void {
    reserved[category] = reservedFor(category) + cost;
  }

  function releaseReservation(category: RateCategory, cost: number): void {
    const next = reservedFor(category) - cost;
    reserved[category] = next > 0 ? next : 0;
  }

  type HardBlock = { reason: string; code: "working_hours" | "budget_exhausted" };

  /** Blocks the caller must not wait on: working hours, budgets. */
  function hardBlockingReason(
    category: RateCategory,
    rule: CategoryRule,
    cost: number,
  ): HardBlock | null {
    if (rule.workingHoursOnly) {
      const wh = checkWorkingHours(cfg.workingHours, log);
      if (!wh.ok) {
        return {
          code: "working_hours",
          reason: `Outside working hours (${wh.windowLabel}). Writes are paused until the next window.`,
        };
      }
    }

    const label = category.replace("_", " ");
    const inFlight = reservedFor(category);

    const daily = windowTotal(sumCategoryAcrossDates(state, category, 1)) + inFlight;
    if (daily + cost > rule.dailyLimit) {
      const reset = new Date();
      reset.setUTCHours(24, 0, 0, 0);
      return {
        code: "budget_exhausted",
        reason: `Daily ${label} budget exhausted: ${daily}/${rule.dailyLimit} used today (cost ${cost}${inFlight > 0 ? `, ${inFlight} in-flight` : ""}). Resets at ${reset.toISOString()}.`,
      };
    }

    if (rule.weeklyLimit !== undefined) {
      const weekly = windowTotal(sumCategoryAcrossDates(state, category, 7)) + inFlight;
      if (weekly + cost > rule.weeklyLimit) {
        return {
          code: "budget_exhausted",
          reason: `Weekly ${label} budget exhausted: ${weekly}/${rule.weeklyLimit} used in the last 7 days (cost ${cost}). Rolling window — retry once older usage ages out (may take up to 7 days).`,
        };
      }
    }

    if (rule.monthlyLimit !== undefined) {
      const monthly = windowTotal(sumCategoryAcrossDates(state, category, 30)) + inFlight;
      if (monthly + cost > rule.monthlyLimit) {
        return {
          code: "budget_exhausted",
          reason: `Monthly ${label} budget exhausted: ${monthly}/${rule.monthlyLimit} used in the last 30 days (cost ${cost}). Rolling window — retry once older usage ages out (may take up to 30 days).`,
        };
      }
    }

    return null;
  }

  type SoftBlock = { waitMs: number; reason: string; code: "spacing" | "cooldown" };

  /**
   * Waitable blocks: spacing, polling cooldown. Returns both the ms to wait
   * and the user-facing reason, so the caller can either sleep or surface it.
   */
  function softBlock(
    category: RateCategory,
    rule: CategoryRule,
    cooldownKey: string,
  ): SoftBlock | null {
    const label = category.replace("_", " ");

    const spacingLeft = minSpacingRemainingSec(
      readIsoAsMs(state.lastCallAt[category]),
      rule.minSpacingSec,
    );
    if (spacingLeft > 0) {
      return {
        code: "spacing",
        waitMs: spacingLeft * 1000,
        reason: `Minimum spacing for ${label}: wait ${formatSeconds(spacingLeft)} before the next call.`,
      };
    }

    const cooldownLeft = cooldownRemainingSec(
      readIsoAsMs(state.lastCooldownAt[cooldownKey]),
      rule.cooldownSec,
    );
    if (cooldownLeft > 0) {
      return {
        code: "cooldown",
        waitMs: cooldownLeft * 1000,
        reason: `Polling cooldown active for ${cooldownKey}: wait ${formatSeconds(cooldownLeft)} before the next call.`,
      };
    }

    return null;
  }

  function recordEvent(event: UsageEvent): void {
    const evicted = pushEvent(state, event, cfg.telemetry.eventRingSize);
    if (evicted) pendingArchiveEvents.push(evicted);
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
      const inFlight = reservedFor(cat);
      const spacingLeftSec = minSpacingRemainingSec(
        readIsoAsMs(state.lastCallAt[cat]),
        rule.minSpacingSec,
      );
      categories[cat] = {
        today: {
          used: day,
          limit: rule.dailyLimit,
          remaining: Math.max(0, rule.dailyLimit - windowTotal(day) - inFlight),
        },
        week: {
          used: week,
          limit: rule.weeklyLimit ?? null,
          remaining:
            rule.weeklyLimit === undefined
              ? null
              : Math.max(0, rule.weeklyLimit - windowTotal(week) - inFlight),
        },
        month: {
          used: month,
          limit: rule.monthlyLimit ?? null,
          remaining:
            rule.monthlyLimit === undefined
              ? null
              : Math.max(0, rule.monthlyLimit - windowTotal(month) - inFlight),
        },
        inFlight,
        minSpacingSec: rule.minSpacingSec,
        secondsUntilSpacingCleared: spacingLeftSec,
        spacingReadyAt:
          spacingLeftSec > 0 ? new Date(Date.now() + spacingLeftSec * 1000).toISOString() : null,
        workingHoursOnly: rule.workingHoursOnly,
        serializeCalls: rule.serializeCalls,
      };
    }

    const pollCooldownSec = rules.relation_poll.cooldownSec;
    const cooldowns: Record<
      string,
      { cooldownSec: number; secondsRemaining: number; readyAt: string | null }
    > = {};
    for (const key of Object.keys(state.lastCooldownAt)) {
      const remaining = cooldownRemainingSec(
        readIsoAsMs(state.lastCooldownAt[key]),
        pollCooldownSec,
      );
      cooldowns[key] = {
        cooldownSec: pollCooldownSec,
        secondsRemaining: remaining,
        readyAt: remaining > 0 ? new Date(Date.now() + remaining * 1000).toISOString() : null,
      };
    }

    const eventLimit = Math.max(0, opts.eventLimit ?? 20);
    const nextOk = wh.ok ? null : nextWorkingHoursStart(cfg.workingHours, log);
    return {
      generatedAt: nowIso(),
      accountId: cfg.accountId,
      accountTier: cfg.accountTier,
      workingHours: {
        ok: wh.ok,
        window: wh.windowLabel,
        nextOkAt: nextOk ? nextOk.toISOString() : null,
      },
      categories,
      cooldowns,
      perToolToday: { ...(state.aggregates.perTool[today] ?? {}) },
      recentEvents: state.events.slice(0, eventLimit),
    };
  }

  return {
    runExclusive: (fn) => mutex.runExclusive(fn),

    getRule: (category) => rules[category],

    async gate({ toolName, category, cost = 1, cooldownKey, waitUpToSec = 0, onUpdate }) {
      const rule = rules[category];
      const key = cooldownKey ?? category;

      const rejectWith = (
        reason: string,
        code: "working_hours" | "budget_exhausted" | "spacing" | "cooldown",
      ): never => {
        recordEvent({
          t: nowIso(),
          tool: toolName,
          cat: category,
          cost,
          result: "blocked",
          reason,
        });
        schedulePersist();
        throw new UnipileLimitError(reason, code);
      };

      // Hard blocks — not waitable.
      const hard = hardBlockingReason(category, rule, cost);
      if (hard) rejectWith(hard.reason, hard.code);

      // Soft blocks — sleep if within the caller's wait budget, else reject.
      const soft = softBlock(category, rule, key);
      if (soft) {
        const waitBudgetMs = Math.max(0, waitUpToSec) * 1000;
        if (soft.waitMs > waitBudgetMs) rejectWith(soft.reason, soft.code);
        if (onUpdate) {
          // Emit a heartbeat every ~10 s so the harness's per-tool timeout
          // resets on each update and the user sees live progress rather
          // than a stuck tool call. The final call result (success or error)
          // is still what the agent's turn actually consumes.
          const waitCode = soft.code;
          await sleepWithHeartbeat(soft.waitMs, 10_000, (remMs) => {
            const secondsRemaining = Math.ceil(remMs / 1000);
            onUpdate({
              content: [
                {
                  type: "text",
                  text: `[unipile:${toolName}] ${soft.reason} (~${secondsRemaining}s remaining)`,
                },
              ],
              details: {
                status: "waiting",
                blockingCode: waitCode,
                category,
                secondsRemaining,
                readyAt: new Date(Date.now() + remMs).toISOString(),
              },
            });
          });
        } else {
          await sleep(soft.waitMs);
        }
        // Re-check hard blocks: the sleep may have crossed a working-hours
        // boundary. Re-check soft too — with the mutex serializing writes and
        // spacing only advancing on recordSuccess, this is belt-and-braces.
        const hardAgain = hardBlockingReason(category, rule, cost);
        if (hardAgain) rejectWith(hardAgain.reason, hardAgain.code);
        const softAgain = softBlock(category, rule, key);
        if (softAgain) rejectWith(softAgain.reason, softAgain.code);
      }

      addReservation(category, cost);
      await jitter(cfg.pacing.jitterMinMs, cfg.pacing.jitterMaxMs);
    },

    recordSuccess({
      toolName,
      category,
      cost = 1,
      reservedCost,
      cooldownKey,
      durationMs,
      indeterminate,
    }) {
      releaseReservation(category, reservedCost ?? cost);
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

    recordFailure({ toolName, category, reservedCost = 1, cooldownKey, durationMs, err }) {
      releaseReservation(category, reservedCost);
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

    checkAffordability({ category, cost = 1, cooldownKey }) {
      const rule = rules[category];
      const key = cooldownKey ?? category;
      const inFlight = reservedFor(category);
      const dayTotal = windowTotal(sumCategoryAcrossDates(state, category, 1));
      const weekTotal = windowTotal(sumCategoryAcrossDates(state, category, 7));
      const monthTotal = windowTotal(sumCategoryAcrossDates(state, category, 30));
      const remaining = {
        today: Math.max(0, rule.dailyLimit - dayTotal - inFlight),
        week:
          rule.weeklyLimit === undefined
            ? null
            : Math.max(0, rule.weeklyLimit - weekTotal - inFlight),
        month:
          rule.monthlyLimit === undefined
            ? null
            : Math.max(0, rule.monthlyLimit - monthTotal - inFlight),
      };

      // Bypass categories never block.
      if (rule.bypassAll) {
        return { ok: true, blockingReason: null, blockingCode: null, retryAt: null, remaining };
      }

      const hard = hardBlockingReason(category, rule, cost);
      if (hard) {
        let retryAt: string | null = null;
        if (hard.code === "working_hours") {
          const t = nextWorkingHoursStart(cfg.workingHours, log);
          if (t) retryAt = t.toISOString();
        } else if (/Daily.+budget exhausted/.test(hard.reason)) {
          const reset = new Date();
          reset.setUTCHours(24, 0, 0, 0);
          retryAt = reset.toISOString();
        }
        // Weekly/monthly are rolling — no exact retryAt. Leave null.
        return {
          ok: false,
          blockingReason: hard.reason,
          blockingCode: hard.code,
          retryAt,
          remaining,
        };
      }

      const soft = softBlock(category, rule, key);
      if (soft) {
        return {
          ok: false,
          blockingReason: soft.reason,
          blockingCode: soft.code,
          retryAt: new Date(Date.now() + soft.waitMs).toISOString(),
          remaining,
        };
      }

      return { ok: true, blockingReason: null, blockingCode: null, retryAt: null, remaining };
    },

    report(opts) {
      return buildReport(opts);
    },

    flush() {
      persistNow();
    },
  };
}
