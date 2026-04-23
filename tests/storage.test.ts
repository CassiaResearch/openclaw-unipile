import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCategoryCount,
  addToolCount,
  hasDedupHash,
  hashText,
  loadUsage,
  pushDedupHash,
  pushEvent,
  saveUsage,
} from "../src/rateLimit/storage.js";
import { cleanupStorage, useTempStorage } from "./helpers.js";

const ACCOUNT = "test-account";

describe("storage — persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = useTempStorage();
  });

  afterEach(() => {
    cleanupStorage(dir);
  });

  it("round-trips aggregates, events, and dedup hashes", () => {
    const state = loadUsage(ACCOUNT, { accountTier: "sales_navigator" });
    addCategoryCount(state, "2026-04-22", "invitation_write", { calls: 5 });
    addCategoryCount(state, "2026-04-22", "invitation_write", { penalty: 10 });
    addToolCount(state, "2026-04-22", "linkedin_send_invitation", 5);
    pushEvent(
      state,
      {
        t: "2026-04-22T10:00:00.000Z",
        tool: "linkedin_send_invitation",
        cat: "invitation_write",
        cost: 1,
        result: "ok",
      },
      100,
    );
    pushDedupHash(state, "msg:chat-1", "Hello there");

    saveUsage(ACCOUNT, state);
    const loaded = loadUsage(ACCOUNT, { accountTier: "sales_navigator" });

    expect(loaded.aggregates.daily["2026-04-22"]?.invitation_write).toEqual({
      calls: 5,
      penalty: 10,
    });
    expect(loaded.aggregates.perTool["2026-04-22"]?.linkedin_send_invitation).toBe(5);
    expect(loaded.events).toHaveLength(1);
    expect(loaded.recentSends["msg:chat-1"]).toHaveLength(1);
    expect(hasDedupHash(loaded, "msg:chat-1", "HELLO there")).toBe(true);
  });

  it("returns a fresh state when the file is missing", () => {
    const state = loadUsage(ACCOUNT, { accountTier: "classic" });
    expect(state.aggregates.daily).toEqual({});
    expect(state.events).toEqual([]);
    expect(state.accountTier).toBe("classic");
  });

  it("calls onCorruption and returns fresh state on malformed JSON", () => {
    const p = path.join(dir, ".openclaw", "unipile", ACCOUNT, "usage.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not json");

    let corruptionErr: unknown;
    const state = loadUsage(ACCOUNT, {
      accountTier: "classic",
      onCorruption: (e) => {
        corruptionErr = e;
      },
    });

    expect(corruptionErr).toBeInstanceOf(Error);
    expect(state.aggregates.daily).toEqual({});
  });

  it("drops stray top-level keys on load (whitelist)", () => {
    const p = path.join(dir, ".openclaw", "unipile", ACCOUNT, "usage.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        accountId: ACCOUNT,
        accountTier: "sales_navigator",
        foo: "should not survive",
        aggregates: { daily: {}, perTool: {} },
      }),
    );

    const state = loadUsage(ACCOUNT, { accountTier: "sales_navigator" });
    expect((state as unknown as Record<string, unknown>).foo).toBeUndefined();
  });
});

describe("dedup helpers", () => {
  it("hashText normalizes whitespace and case", () => {
    expect(hashText("Hi there")).toBe(hashText("  hi  THERE\n"));
    expect(hashText("Hi there")).toBe(hashText("hi\tthere"));
    expect(hashText("a")).not.toBe(hashText("b"));
  });

  it("pushDedupHash caps the ring at 100 entries and skips consecutive duplicates", () => {
    const state = loadUsage("a", { accountTier: "classic" });
    for (let i = 0; i < 105; i++) pushDedupHash(state, "k", `msg${i}`);
    expect(state.recentSends.k?.length).toBe(100);

    // Pushing the same hash twice in a row doesn't double-record.
    const before = state.recentSends.k?.length ?? 0;
    pushDedupHash(state, "k", "msg104");
    expect(state.recentSends.k?.length).toBe(before);
  });

  it("hasDedupHash detects prior sends by normalized equivalence", () => {
    const state = loadUsage("a", { accountTier: "classic" });
    pushDedupHash(state, "msg:chat-1", "Hey, got a minute?");
    expect(hasDedupHash(state, "msg:chat-1", "hey, GOT a minute?")).toBe(true);
    expect(hasDedupHash(state, "msg:chat-1", "Hey, got a second?")).toBe(false);
    expect(hasDedupHash(state, "msg:other", "Hey, got a minute?")).toBe(false);
  });
});
