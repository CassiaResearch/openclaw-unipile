import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../src/rateLimit/index.js";
import { runUnipileTool, type ToolContext } from "../src/tools/runner.js";
import { cleanupStorage, makeConfig, silentLog, unwrapToolText, useTempStorage } from "./helpers.js";

const WED_10AM = new Date("2026-04-22T10:00:00Z");

function makeCtx(): ToolContext {
  const cfg = makeConfig();
  const limiter = createRateLimiter(cfg, silentLog);
  // Client is never called — tests stub `run` themselves.
  return { cfg, client: {} as never, limiter, log: silentLog };
}

describe("runUnipileTool", () => {
  let dir: string;

  beforeEach(() => {
    dir = useTempStorage();
    vi.useFakeTimers({ now: WED_10AM });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupStorage(dir);
  });

  it("happy path serializes result and counts 1 call", async () => {
    const ctx = makeCtx();
    const res = await runUnipileTool(ctx, {
      toolName: "linkedin_get_profile",
      category: "profile_read",
      run: async () => ({ id: "abc" }),
    });
    expect(unwrapToolText(res.content[0]!.text)).toBe(JSON.stringify({ id: "abc" }));
    const report = ctx.limiter.report();
    expect(report.categories.profile_read?.today.used.calls).toBe(1);
    expect(report.categories.profile_read?.inFlight).toBe(0);
  });

  it("returns a limit error text when the gate blocks, no call recorded", async () => {
    const cfg = makeConfig({
      accountTier: "classic",
      limits: { ...makeConfig().limits, profileReadsPerDay: 1 },
    });
    const limiter = createRateLimiter(cfg, silentLog);
    const ctx: ToolContext = { cfg, client: {} as never, limiter, log: silentLog };
    // Burn the only slot.
    await runUnipileTool(ctx, {
      toolName: "linkedin_get_profile",
      category: "profile_read",
      run: async () => ({}),
    });
    const blocked = await runUnipileTool(ctx, {
      toolName: "linkedin_get_profile",
      category: "profile_read",
      run: async () => {
        throw new Error("should not be called");
      },
    });
    expect(blocked.content[0]?.text).toMatch(/Daily.+budget exhausted/);
  });

  it("indeterminate write (504) counts the call against budget and flags the result", async () => {
    const ctx = makeCtx();
    const timeout504 = { body: { status: 504, type: "errors/request_timeout" } };
    const res = await runUnipileTool(ctx, {
      toolName: "linkedin_send_message",
      category: "message_write",
      run: async () => {
        throw timeout504;
      },
    });
    expect(res.content[0]?.text).toMatch(/timed out/);
    expect(res.isError).toBe(true);

    const report = ctx.limiter.report({ eventLimit: 5 });
    expect(report.categories.message_write?.today.used.calls).toBe(1);
    expect(report.recentEvents[0]?.result).toBe("indeterminate");
  });

  it("actualCost overrides reservedCost on success (search-result billing)", async () => {
    const ctx = makeCtx();
    await runUnipileTool(ctx, {
      toolName: "linkedin_search",
      category: "search_results",
      reservedCost: 50,
      actualCost: (r: { items: unknown[] }) => r.items.length,
      run: async () => ({ items: [1, 2, 3] }),
    });
    const report = ctx.limiter.report();
    expect(report.categories.search_results?.today.used.calls).toBe(3);
    expect(report.categories.search_results?.inFlight).toBe(0);
  });

  it("429 failure records a penalty and leaves no reservation behind", async () => {
    const ctx = makeCtx();
    const err429 = { body: { status: 429, type: "errors/too_many_requests" } };
    const res = await runUnipileTool(ctx, {
      toolName: "linkedin_get_profile",
      category: "profile_read",
      run: async () => {
        throw err429;
      },
    });
    expect(res.content[0]?.text).toMatch(/rate limit hit/i);
    const report = ctx.limiter.report();
    expect(report.categories.profile_read?.today.used.penalty).toBe(5);
    expect(report.categories.profile_read?.inFlight).toBe(0);
  });

  it("bypass category (cached_read) neither gates nor records usage", async () => {
    const ctx = makeCtx();
    const res = await runUnipileTool(ctx, {
      toolName: "linkedin_list_chats",
      category: "cached_read",
      run: async () => ({ items: [] }),
    });
    expect(unwrapToolText(res.content[0]!.text)).toBe(JSON.stringify({ items: [] }));
    const report = ctx.limiter.report();
    // cached_read is bypassAll; not represented in the report.
    expect(report.categories.cached_read).toBeUndefined();
  });

  it("maps errors/already_connected to the guidance message", async () => {
    const ctx = makeCtx();
    const err = { body: { status: 422, type: "errors/already_connected" } };
    const res = await runUnipileTool(ctx, {
      toolName: "linkedin_send_invitation",
      category: "invitation_write",
      run: async () => {
        throw err;
      },
    });
    expect(res.content[0]?.text).toMatch(/1st-degree connection/);
  });
});
