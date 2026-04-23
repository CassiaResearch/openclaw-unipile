import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AccountTier, RateCategory } from "../types.js";

const STORAGE_SCHEMA_VERSION = 1;

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
  /**
   * Hashes of recently-sent message bodies, keyed per target (chatId or
   * sorted attendee list). Newest-first, capped at MAX_DEDUP_HASHES_PER_KEY
   * to bound file size. Used to prevent sending the same text to the same
   * recipient twice.
   */
  recentSends: Record<string, string[]>;
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

function filePath(accountId: string): string {
  const home = homeOverrideForTests ?? os.homedir();
  return path.join(home, ".openclaw", "unipile", accountId, "usage.json");
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
    recentSends: {},
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
      recentSends: parsed.recentSends ?? {},
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
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, target);
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

export function pushEvent(state: UsageState, event: UsageEvent, ringSize: number): void {
  // Most-recent-first ordering makes "what just happened" reads cheap.
  state.events.unshift(event);
  if (state.events.length > ringSize) {
    state.events.length = ringSize;
  }
}

export function readIsoAsMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

const MAX_DEDUP_HASHES_PER_KEY = 100;

/**
 * SHA-256 prefix of normalized text — lower-cased, whitespace-collapsed. 128
 * bits is collision-proof enough for per-chat history.
 */
export function hashText(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function hasDedupHash(state: UsageState, key: string, text: string): boolean {
  const prior = state.recentSends[key];
  if (!prior || prior.length === 0) return false;
  return prior.includes(hashText(text));
}

export function pushDedupHash(state: UsageState, key: string, text: string): void {
  const hash = hashText(text);
  const prior = state.recentSends[key] ?? [];
  // Newest-first FIFO, capped. Don't double-record if already there.
  if (prior[0] === hash) return;
  prior.unshift(hash);
  if (prior.length > MAX_DEDUP_HASHES_PER_KEY) prior.length = MAX_DEDUP_HASHES_PER_KEY;
  state.recentSends[key] = prior;
}
