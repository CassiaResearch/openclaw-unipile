import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../src/rateLimit/index.js";
import {
  addCategoryCount,
  archiveEvents,
  archiveOldDailyAggregates,
  eventsArchivePath,
  historyPath,
  HOT_WINDOW_DAYS,
  loadUsage,
  saveUsage,
} from "../src/rateLimit/storage.js";
import { cleanupStorage, makeConfig, silentLog, useTempStorage } from "./helpers.js";

const ACCOUNT = "test-account";

describe("archive — usage-history.jsonl rollover", () => {
  let dir: string;

  beforeEach(() => {
    dir = useTempStorage();
  });

  afterEach(() => {
    cleanupStorage(dir);
  });

  it("moves days older than HOT_WINDOW_DAYS into usage-history.jsonl", () => {
    const state = loadUsage(ACCOUNT, { accountTier: "classic" });
    // Days that should stay in hot storage.
    const today = new Date();
    const recent = new Date(today.getTime() - 5 * 86400000).toISOString().slice(0, 10);
    const stale = new Date(today.getTime() - (HOT_WINDOW_DAYS + 5) * 86400000)
      .toISOString()
      .slice(0, 10);

    addCategoryCount(state, recent, "profile_read", { calls: 3 });
    addCategoryCount(state, stale, "profile_read", { calls: 42 });

    const archived = archiveOldDailyAggregates(ACCOUNT, state);
    expect(archived).toBe(1);
    expect(state.aggregates.daily[stale]).toBeUndefined();
    expect(state.aggregates.daily[recent]).toBeDefined();

    const lines = fs
      .readFileSync(historyPath(ACCOUNT), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ date: stale, counts: { profile_read: { calls: 42 } } });
  });

  it("appends rather than overwrites on repeated rollovers", () => {
    const state = loadUsage(ACCOUNT, { accountTier: "classic" });
    const stale1 = new Date(Date.now() - (HOT_WINDOW_DAYS + 10) * 86400000)
      .toISOString()
      .slice(0, 10);
    const stale2 = new Date(Date.now() - (HOT_WINDOW_DAYS + 11) * 86400000)
      .toISOString()
      .slice(0, 10);
    addCategoryCount(state, stale1, "profile_read", { calls: 1 });
    archiveOldDailyAggregates(ACCOUNT, state);
    addCategoryCount(state, stale2, "profile_read", { calls: 2 });
    archiveOldDailyAggregates(ACCOUNT, state);

    const lines = fs.readFileSync(historyPath(ACCOUNT), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("creates no history file when nothing is stale", () => {
    const state = loadUsage(ACCOUNT, { accountTier: "classic" });
    const today = new Date().toISOString().slice(0, 10);
    addCategoryCount(state, today, "profile_read", { calls: 1 });
    expect(archiveOldDailyAggregates(ACCOUNT, state)).toBe(0);
    expect(fs.existsSync(historyPath(ACCOUNT))).toBe(false);
  });

  it("archives evicted events to events.jsonl", () => {
    archiveEvents(ACCOUNT, [
      { t: "2026-04-22T10:00:00.000Z", tool: "t", cat: "profile_read", cost: 1, result: "ok" },
      { t: "2026-04-22T10:00:01.000Z", tool: "t", cat: "profile_read", cost: 1, result: "ok" },
    ]);
    const lines = fs.readFileSync(eventsArchivePath(ACCOUNT), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("writes usage.json with 0o600 permissions", () => {
    const state = loadUsage(ACCOUNT, { accountTier: "classic" });
    saveUsage(ACCOUNT, state);
    const p = path.join(dir, ".openclaw", "unipile", ACCOUNT, "usage.json");
    const mode = fs.statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("rate limiter — archive integration", () => {
  let dir: string;

  beforeEach(() => {
    dir = useTempStorage();
    vi.useFakeTimers({ now: new Date("2026-04-22T10:00:00Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupStorage(dir);
  });

  it("flush() archives evicted events and stale daily aggregates", () => {
    const limiter = createRateLimiter(makeConfig({ telemetry: { eventRingSize: 2 } }), silentLog);
    limiter.recordSuccess({ toolName: "t", category: "profile_read" });
    limiter.recordSuccess({ toolName: "t", category: "profile_read" });
    limiter.recordSuccess({ toolName: "t", category: "profile_read" });
    // Third event evicts the first out of the ring of size 2.
    limiter.flush();
    const lines = fs.readFileSync(eventsArchivePath("test-account"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});
