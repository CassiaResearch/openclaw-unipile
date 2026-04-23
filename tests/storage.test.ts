import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCategoryCount,
  addToolCount,
  loadUsage,
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
    saveUsage(ACCOUNT, state);
    const loaded = loadUsage(ACCOUNT, { accountTier: "sales_navigator" });

    expect(loaded.aggregates.daily["2026-04-22"]?.invitation_write).toEqual({
      calls: 5,
      penalty: 10,
    });
    expect(loaded.aggregates.perTool["2026-04-22"]?.linkedin_send_invitation).toBe(5);
    expect(loaded.events).toHaveLength(1);
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
