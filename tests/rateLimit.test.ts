import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, type RateLimiter } from "../src/rateLimit/index.js";
import { cleanupStorage, makeConfig, silentLog, useTempStorage } from "./helpers.js";

// Wed 2026-04-22 10:00 UTC — during working hours on a working day.
const WED_10AM = new Date("2026-04-22T10:00:00Z");

describe("rate limiter — gate decisions", () => {
  let dir: string;
  let limiter: RateLimiter;

  beforeEach(() => {
    dir = useTempStorage();
    vi.useFakeTimers({ now: WED_10AM });
    limiter = createRateLimiter(makeConfig(), silentLog);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupStorage(dir);
  });

  it("blocks once the daily invite budget is reached", async () => {
    // Spacing=0 so we isolate budget behavior from the ≥90 s invite rail.
    limiter = createRateLimiter(
      makeConfig({
        limits: { ...makeConfig().limits, invitationsPerDay: 2 },
        pacing: { ...makeConfig().pacing, invitationMinSpacingSec: 0 },
      }),
      silentLog,
    );
    for (let i = 0; i < 2; i++) {
      await limiter.gate({ toolName: "inv", category: "invitation_write" });
      limiter.recordSuccess({ toolName: "inv", category: "invitation_write" });
    }
    await expect(limiter.gate({ toolName: "inv", category: "invitation_write" })).rejects.toThrow(
      /Daily.+budget exhausted.+2\/2/,
    );
  });

  it("blocks when the weekly cap is exhausted before the daily cap", async () => {
    limiter = createRateLimiter(
      makeConfig({
        limits: { ...makeConfig().limits, invitationsPerDay: 50, invitationsPerWeek: 2 },
        pacing: { ...makeConfig().pacing, invitationMinSpacingSec: 0 },
      }),
      silentLog,
    );
    for (let i = 0; i < 2; i++) {
      await limiter.gate({ toolName: "inv", category: "invitation_write" });
      limiter.recordSuccess({ toolName: "inv", category: "invitation_write" });
    }
    await expect(limiter.gate({ toolName: "inv", category: "invitation_write" })).rejects.toThrow(
      /Weekly.+budget exhausted/,
    );
  });

  it("enforces 90 s spacing between invitations", async () => {
    await limiter.gate({ toolName: "inv", category: "invitation_write" });
    limiter.recordSuccess({ toolName: "inv", category: "invitation_write" });

    vi.advanceTimersByTime(60_000);
    await expect(limiter.gate({ toolName: "inv", category: "invitation_write" })).rejects.toThrow(
      /Minimum spacing/,
    );

    vi.advanceTimersByTime(31_000);
    await expect(
      limiter.gate({ toolName: "inv", category: "invitation_write" }),
    ).resolves.toBeUndefined();
  });

  it("polling cooldown is per-tool, not per-category", async () => {
    await limiter.gate({
      toolName: "linkedin_list_relations",
      category: "relation_poll",
      cooldownKey: "linkedin_list_relations",
    });
    limiter.recordSuccess({
      toolName: "linkedin_list_relations",
      category: "relation_poll",
      cooldownKey: "linkedin_list_relations",
    });

    vi.advanceTimersByTime(2 * 60 * 60 * 1000); // 2h

    await expect(
      limiter.gate({
        toolName: "linkedin_list_relations",
        category: "relation_poll",
        cooldownKey: "linkedin_list_relations",
      }),
    ).rejects.toThrow(/Polling cooldown/);

    // A different polling tool shares the category but not the cooldown key.
    await expect(
      limiter.gate({
        toolName: "linkedin_list_invitations_sent",
        category: "relation_poll",
        cooldownKey: "linkedin_list_invitations_sent",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks writes on non-working days but allows reads", async () => {
    // Saturday 10:00 UTC.
    vi.setSystemTime(new Date("2026-04-25T10:00:00Z"));

    await expect(limiter.gate({ toolName: "inv", category: "invitation_write" })).rejects.toThrow(
      /Outside working hours/,
    );

    // profile_read has workingHoursOnly=false.
    await expect(
      limiter.gate({ toolName: "p", category: "profile_read" }),
    ).resolves.toBeUndefined();
  });

  it("blocks writes outside the hour window", async () => {
    // Wed 22:00 UTC — past 18:00 end.
    vi.setSystemTime(new Date("2026-04-22T22:00:00Z"));
    await expect(limiter.gate({ toolName: "inv", category: "invitation_write" })).rejects.toThrow(
      /Outside working hours/,
    );
  });

  it("records a 429 as a 5× penalty and pushes spacing forward", async () => {
    const err429 = { body: { status: 429, type: "errors/too_many_requests" } };
    limiter.recordFailure({ toolName: "inv", category: "invitation_write", err: err429 });

    const report = limiter.report();
    expect(report.categories.invitation_write?.today.used.penalty).toBe(5);
    expect(report.categories.invitation_write?.today.used.calls).toBe(0);

    // lastCallAt is pushed ~120 s into the future; spacing still fails after 60 s real-time.
    vi.advanceTimersByTime(60_000);
    await expect(limiter.gate({ toolName: "inv", category: "invitation_write" })).rejects.toThrow(
      /Minimum spacing/,
    );
  });

  it("indeterminate flag tags the event as 'indeterminate'", () => {
    limiter.recordSuccess({ toolName: "inv", category: "invitation_write", indeterminate: true });
    const report = limiter.report({ eventLimit: 1 });
    expect(report.recentEvents[0]).toMatchObject({ tool: "inv", result: "indeterminate" });
    // Still counts against the daily budget (conservative: it may have landed).
    expect(report.categories.invitation_write?.today.used.calls).toBe(1);
  });

  it("reserves budget at gate() so parallel reads can't overshoot the cap", async () => {
    limiter = createRateLimiter(
      makeConfig({
        accountTier: "classic",
        limits: { ...makeConfig().limits, profileReadsPerDay: 3 },
      }),
      silentLog,
    );
    // Three concurrent gates, all before any recordSuccess — the 4th must fail
    // because the first three have reserved the entire daily cap.
    await limiter.gate({ toolName: "p", category: "profile_read" });
    await limiter.gate({ toolName: "p", category: "profile_read" });
    await limiter.gate({ toolName: "p", category: "profile_read" });
    await expect(limiter.gate({ toolName: "p", category: "profile_read" })).rejects.toThrow(
      /Daily.+budget exhausted.+3\/3.+3 in-flight/,
    );
  });

  it("reservations are released on recordSuccess and recordFailure", async () => {
    limiter = createRateLimiter(
      makeConfig({
        accountTier: "classic",
        limits: { ...makeConfig().limits, profileReadsPerDay: 2 },
      }),
      silentLog,
    );
    await limiter.gate({ toolName: "p", category: "profile_read" });
    limiter.recordSuccess({ toolName: "p", category: "profile_read" });
    await limiter.gate({ toolName: "p", category: "profile_read" });
    limiter.recordFailure({ toolName: "p", category: "profile_read", err: new Error("x") });
    // 1 persisted call + 0 in-flight = 1/2. A fresh gate should still succeed.
    await expect(
      limiter.gate({ toolName: "p", category: "profile_read" }),
    ).resolves.toBeUndefined();
  });

  it("actualCost smaller than reservedCost releases the full reservation", async () => {
    limiter = createRateLimiter(
      makeConfig({
        limits: { ...makeConfig().limits, searchResultsPerDay: 10 },
      }),
      silentLog,
    );
    await limiter.gate({ toolName: "s", category: "search_results", cost: 5 });
    // Fewer results came back than reserved.
    limiter.recordSuccess({
      toolName: "s",
      category: "search_results",
      cost: 2,
      reservedCost: 5,
    });
    const report = limiter.report();
    expect(report.categories.search_results?.inFlight).toBe(0);
    expect(report.categories.search_results?.today.used.calls).toBe(2);
  });

  it("dedup block is logged as a 'blocked' event for observability", () => {
    limiter.recordBlocked({
      toolName: "msg",
      category: "message_write",
      reason: "Duplicate message detected",
    });
    const report = limiter.report({ eventLimit: 1 });
    expect(report.recentEvents[0]).toMatchObject({
      tool: "msg",
      result: "blocked",
      reason: "Duplicate message detected",
    });
  });
});
