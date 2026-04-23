import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AccountTier, RateCategory } from "../types.js";

const STORAGE_SCHEMA_VERSION = 1;

/**
 * How many days of per-day aggregates are kept in the hot usage.json file.
 * Must be ≥ the longest budget window (monthlyLimit is 30 days). Older days
 * are evicted to usage-history.jsonl on save.
 */
export const HOT_WINDOW_DAYS = 31;

export interface CategoryCounts {
  calls: number;
  penalty: number;
}

export type DailyCategoryCounts = Partial<Record<RateCategory, CategoryCounts>>;
export type PerToolCounts = Record<string, number>;

export type EventResult = "ok" | "blocked" | "error" | "indeterminate";

export interface UsageEvent {
  t: string; // ISO 8601
  tool: string;
  cat: RateCategory;
  cost: number;
  result: EventResult;
  durationMs?: number;
  errorStatus?: number;
  reason?: string;
}

export interface UsageState {
  version: number;
  accountId: string;
  accountTier: AccountTier;
  createdAt: string;
  updatedAt: string;
  aggregates: {
    daily: Record<string, DailyCategoryCounts>;
    perTool: Record<string, PerToolCounts>;
  };
  lastCallAt: Partial<Record<RateCategory, string>>;
  lastCooldownAt: Record<string, string>;
  events: UsageEvent[];
}

export interface LoadOptions {
  accountTier: AccountTier;
  onCorruption?: (err: unknown) => void;
}

export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function nowIso(now = new Date()): string {
  return now.toISOString();
}

let homeOverrideForTests: string | undefined;

/** @internal Test-only: redirect usage.json to a temp directory. */
export function setStorageHomeForTests(dir: string | undefined): void {
  homeOverrideForTests = dir;
}

function accountDir(accountId: string): string {
  const home = homeOverrideForTests ?? os.homedir();
  return path.join(home, ".openclaw", "unipile", accountId);
}

function filePath(accountId: string): string {
  return path.join(accountDir(accountId), "usage.json");
}

export function historyPath(accountId: string): string {
  return path.join(accountDir(accountId), "usage-history.jsonl");
}

export function eventsArchivePath(accountId: string): string {
  return path.join(accountDir(accountId), "events.jsonl");
}

function emptyState(accountId: string, accountTier: AccountTier): UsageState {
  const now = nowIso();
  return {
    version: STORAGE_SCHEMA_VERSION,
    accountId,
    accountTier,
    createdAt: now,
    updatedAt: now,
    aggregates: { daily: {}, perTool: {} },
    lastCallAt: {},
    lastCooldownAt: {},
    events: [],
  };
}

/**
 * The file is self-owned: we wrote it ~1 s ago. Only failure modes worth
 * handling are "file missing" (first run) and "not parseable JSON" (disk
 * corruption / hand-editing). We whitelist known fields from the parsed blob
 * — extra top-level keys from a hand-edit get dropped on the next save, and
 * missing keys fall back to the empty template.
 */
export function loadUsage(accountId: string, opts: LoadOptions): UsageState {
  const fresh = emptyState(accountId, opts.accountTier);
  const p = filePath(accountId);
  if (!fs.existsSync(p)) return fresh;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<UsageState>;
    return {
      version: STORAGE_SCHEMA_VERSION,
      accountId,
      accountTier: parsed.accountTier ?? opts.accountTier,
      createdAt: parsed.createdAt ?? fresh.createdAt,
      updatedAt: parsed.updatedAt ?? fresh.updatedAt,
      aggregates: {
        daily: parsed.aggregates?.daily ?? {},
        perTool: parsed.aggregates?.perTool ?? {},
      },
      lastCallAt: parsed.lastCallAt ?? {},
      lastCooldownAt: parsed.lastCooldownAt ?? {},
      events: parsed.events ?? [],
    };
  } catch (err) {
    opts.onCorruption?.(err);
    return fresh;
  }
}

export function saveUsage(accountId: string, state: UsageState): void {
  const target = filePath(accountId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  const payload: UsageState = {
    ...state,
    version: STORAGE_SCHEMA_VERSION,
    updatedAt: nowIso(),
  };
  // 0o600: contains per-tool activity and message-body hashes. Not secrets,
  // but not anyone-readable either.
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, target);
}

function appendJsonl(filePath: string, lines: readonly string[]): void {
  if (lines.length === 0) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
}

/**
 * Evict daily aggregate entries older than HOT_WINDOW_DAYS to usage-history.jsonl.
 * History is append-only: one JSON object per line with the date, counts, per-tool
 * totals, and the archive timestamp. The hot file keeps only what the budget
 * windows actually read. Returns the number of dates archived.
 */
export function archiveOldDailyAggregates(
  accountId: string,
  state: UsageState,
  now = new Date(),
): number {
  const cutoffMs = now.getTime() - HOT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const drops: string[] = [];
  for (const date of Object.keys(state.aggregates.daily)) {
    const t = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(t) || t < cutoffMs) drops.push(date);
  }
  if (drops.length === 0) return 0;
  const archivedAt = nowIso(now);
  const lines = drops.map((date) =>
    JSON.stringify({
      date,
      counts: state.aggregates.daily[date] ?? {},
      tools: state.aggregates.perTool[date] ?? {},
      archivedAt,
    }),
  );
  appendJsonl(historyPath(accountId), lines);
  for (const date of drops) {
    delete state.aggregates.daily[date];
    delete state.aggregates.perTool[date];
  }
  return drops.length;
}

/** Append events that have aged out of the in-memory ring to events.jsonl. */
export function archiveEvents(accountId: string, events: readonly UsageEvent[]): void {
  if (events.length === 0) return;
  const lines = events.map((e) => JSON.stringify(e));
  appendJsonl(eventsArchivePath(accountId), lines);
}

export function sumCategoryAcrossDates(
  state: UsageState,
  category: RateCategory,
  daysBack: number,
  now = new Date(),
): CategoryCounts {
  if (daysBack <= 0) return { calls: 0, penalty: 0 };
  const cutoffMs = now.getTime() - daysBack * 24 * 60 * 60 * 1000;
  let calls = 0;
  let penalty = 0;
  for (const [date, counts] of Object.entries(state.aggregates.daily)) {
    const t = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(t) || t < cutoffMs) continue;
    const entry = counts[category];
    if (!entry) continue;
    calls += entry.calls;
    penalty += entry.penalty;
  }
  return { calls, penalty };
}

export function addCategoryCount(
  state: UsageState,
  date: string,
  category: RateCategory,
  delta: { calls?: number; penalty?: number },
): void {
  const day = state.aggregates.daily[date] ?? {};
  const current = day[category] ?? { calls: 0, penalty: 0 };
  day[category] = {
    calls: current.calls + (delta.calls ?? 0),
    penalty: current.penalty + (delta.penalty ?? 0),
  };
  state.aggregates.daily[date] = day;
}

export function addToolCount(state: UsageState, date: string, tool: string, delta: number): void {
  const day = state.aggregates.perTool[date] ?? {};
  day[tool] = (day[tool] ?? 0) + delta;
  state.aggregates.perTool[date] = day;
}

/**
 * Push an event onto the in-memory ring. Returns any event evicted off the
 * tail so the caller can archive it. Newest-first ordering makes "what just
 * happened" reads cheap.
 */
export function pushEvent(
  state: UsageState,
  event: UsageEvent,
  ringSize: number,
): UsageEvent | null {
  state.events.unshift(event);
  if (ringSize <= 0) {
    // ringSize=0 means "don't keep any in-memory history" — archive everything.
    state.events.length = 0;
    return event;
  }
  if (state.events.length > ringSize) {
    const evicted = state.events[ringSize] ?? null;
    state.events.length = ringSize;
    return evicted;
  }
  return null;
}

export function readIsoAsMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}
