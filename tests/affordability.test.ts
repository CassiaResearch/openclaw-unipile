import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../src/rateLimit/index.js";
import { runUnipileTool, type ToolContext } from "../src/tools/runner.js";
import { cleanupStorage, makeConfig, silentLog, useTempStorage } from "./helpers.js";

const WED_10AM = new Date("2026-04-22T10:00:00Z");

describe("gate — waitUpToSec drains naturally", () => {
  let dir: string;

  beforeEach(() => {
    dir = useTempStorage();
    vi.useFakeTimers({ now: WED_10AM });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupStorage(dir);
  });

  it("a spacing block within budget sleeps and then passes", async () => {
    const limiter = createRateLimiter(makeConfig(), silentLog);
    await limiter.gate({ toolName: "inv", category: "invitation_write" });
    limiter.recordSuccess({ toolName: "inv", category: "invitation_write" });

    // Spacing is 90s. Ask to wait up to 120s — should succeed after ~90s.
    const gatePromise = limiter.gate({
      toolName: "inv",
      category: "invitation_write",
      waitUpToSec: 120,
    });
    // Advance past the spacing window.
    await vi.advanceTimersByTimeAsync(95_000);
    await expect(gatePromise).resolves.toBeUndefined();
  });

  it("a spacing block larger than the wait budget throws", async () => {
    const limiter = createRateLimiter(makeConfig(), silentLog);
    await limiter.gate({ toolName: "inv", category: "invitation_write" });
    limiter.recordSuccess({ toolName: "inv", category: "invitation_write" });

    // 30s budget is less than the 90s spacing.
    await expect(
      limiter.gate({ toolName: "inv", category: "invitation_write", waitUpToSec: 30 }),
    ).rejects.toThrow(/Minimum spacing/);
  });

  it("emits heartbeats via onUpdate during spacing wait, at ~10 s cadence", async () => {
    const limiter = createRateLimiter(makeConfig(), silentLog);
    await limiter.gate({ toolName: "inv", category: "invitation_write" });
    limiter.recordSuccess({ toolName: "inv", category: "invitation_write" });

    type Update = { content: { text: string }[]; details?: unknown };
    const updates: Update[] = [];
    const onUpdate = (u: Update) => {
      updates.push(u);
    };

    const gatePromise = limiter.gate({
      toolName: "inv",
      category: "invitation_write",
      waitUpToSec: 120,
      onUpdate,
    });

    // Initial tick fires synchronously before the first await inside gate().
    await Promise.resolve();
    expect(updates.length).toBeGreaterThanOrEqual(1);

    // Advance the full 90 s spacing window in one sweep and let the gate resolve.
    await vi.advanceTimersByTimeAsync(95_000);
    await expect(gatePromise).resolves.toBeUndefined();

    // We should have seen 9 heartbeats (initial + one per 10 s slice, minus
    // the final "remaining > 0" check that suppresses the tail tick).
    expect(updates.length).toBe(9);

    // Every update carries the structured payload the agent can branch on.
    for (const u of updates) {
      const d = u.details as { status?: string; blockingCode?: string; secondsRemaining?: number };
      expect(d.status).toBe("waiting");
      expect(d.blockingCode).toBe("spacing");
      expect(typeof d.secondsRemaining).toBe("number");
    }
    // Countdown should be monotonically decreasing.
    const counts = updates.map((u) => (u.details as { secondsRemaining: number }).secondsRemaining);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThan(counts[i - 1]!);
    }
  });

  it("waitSec=0 on linkedin_send_invitation yields a spacing errorCode, no wait", async () => {
    // Build an invitations harness with the real tool wiring so we verify
    // the param flows through from tool → runner → gate.
    const { registerInvitationTools } = await import("../src/tools/invitations.js");
    const cfg = makeConfig();
    const limiter = createRateLimiter(cfg, silentLog);
    const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
    const api = {
      registerTool: (tool: {
        name: string;
        execute: (id: string, params: unknown) => Promise<unknown>;
      }) => {
        tools.set(tool.name, tool);
      },
    };
    const client = {
      users: {
        sendInvitation: async () => ({ object: "UserInvitationSent", invitation_id: "i1" }),
      },
    };
    registerInvitationTools(api as never, {
      cfg,
      client: client as never,
      limiter,
      log: silentLog,
    });
    const tool = tools.get("linkedin_send_invitation")!;

    // First call — no spacing in play, succeeds.
    await tool.execute("id-1", { providerId: "urn:li:member:1" });
    // Second call immediately after — spacing active, 90 s to go. waitSec=0
    // must reject fast rather than sleeping.
    const start = Date.now();
    const res = (await tool.execute("id-2", {
      providerId: "urn:li:member:2",
      waitSec: 0,
    })) as { isError?: boolean; errorCode?: string };
    const elapsed = Date.now() - start;
    expect(res.isError).toBe(true);
    expect(res.errorCode).toBe("spacing");
    // Should return well under 1s even though real spacing is 90s.
    expect(elapsed).toBeLessThan(500);
  });

  it("budget exhaustion is never waited on, regardless of waitUpToSec", async () => {
    const limiter = createRateLimiter(
      makeConfig({
        accountTier: "classic",
        limits: { ...makeConfig().limits, profileReadsPerDay: 1 },
        pacing: { ...makeConfig().pacing, invitationMinSpacingSec: 0 },
      }),
      silentLog,
    );
    await limiter.gate({ toolName: "p", category: "profile_read" });
    limiter.recordSuccess({ toolName: "p", category: "profile_read" });

    await expect(
      limiter.gate({
        toolName: "p",
        category: "profile_read",
        waitUpToSec: 3600, // one hour — still rejected immediately
      }),
    ).rejects.toThrow(/Daily.+budget exhausted/);
  });
});

describe("checkAffordability — pre-flight batch planning", () => {
  let dir: string;

  beforeEach(() => {
    dir = useTempStorage();
    vi.useFakeTimers({ now: WED_10AM });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupStorage(dir);
  });

  it("returns ok=true with remaining headroom when nothing blocks", () => {
    const limiter = createRateLimiter(makeConfig(), silentLog);
    const res = limiter.checkAffordability({ category: "invitation_write", cost: 10 });
    expect(res.ok).toBe(true);
    expect(res.blockingReason).toBeNull();
    expect(res.retryAt).toBeNull();
    expect(res.remaining.today).toBe(80); // default invitationsPerDay
    expect(res.remaining.week).toBe(200);
    expect(res.remaining.month).toBe(600);
  });

  it("returns ok=false with retryAt pointing at next UTC midnight on daily exhaustion", () => {
    const limiter = createRateLimiter(
      makeConfig({
        limits: { ...makeConfig().limits, invitationsPerDay: 2 },
        pacing: { ...makeConfig().pacing, invitationMinSpacingSec: 0 },
      }),
      silentLog,
    );
    for (let i = 0; i < 2; i++) {
      limiter.recordSuccess({ toolName: "inv", category: "invitation_write" });
    }
    const res = limiter.checkAffordability({ category: "invitation_write", cost: 1 });
    expect(res.ok).toBe(false);
    expect(res.blockingReason).toMatch(/Daily.+budget exhausted/);
    expect(res.retryAt).toBe("2026-04-23T00:00:00.000Z");
    expect(res.remaining.today).toBe(0);
  });

  it("returns ok=false with retryAt on spacing block", () => {
    const limiter = createRateLimiter(makeConfig(), silentLog);
    limiter.recordSuccess({ toolName: "inv", category: "invitation_write" });
    const res = limiter.checkAffordability({ category: "invitation_write", cost: 1 });
    expect(res.ok).toBe(false);
    expect(res.blockingReason).toMatch(/Minimum spacing/);
    const retryMs = Date.parse(res.retryAt!);
    expect(retryMs).toBeGreaterThan(WED_10AM.getTime());
    expect(retryMs).toBeLessThanOrEqual(WED_10AM.getTime() + 90_000);
  });

  it("flags batch cost that would exceed remaining budget", () => {
    const limiter = createRateLimiter(
      makeConfig({
        limits: { ...makeConfig().limits, invitationsPerDay: 5 },
        pacing: { ...makeConfig().pacing, invitationMinSpacingSec: 0 },
      }),
      silentLog,
    );
    // 3 burned → 2 remaining. Ask for 3.
    for (let i = 0; i < 3; i++) {
      limiter.recordSuccess({ toolName: "inv", category: "invitation_write" });
    }
    const affordable = limiter.checkAffordability({ category: "invitation_write", cost: 2 });
    expect(affordable.ok).toBe(true);
    const overbudget = limiter.checkAffordability({ category: "invitation_write", cost: 3 });
    expect(overbudget.ok).toBe(false);
    expect(overbudget.blockingReason).toMatch(/Daily.+budget exhausted/);
  });

  it("working-hours block yields a nextOkAt retryAt", () => {
    // Saturday 10:00 UTC, Mon–Fri working hours.
    vi.setSystemTime(new Date("2026-04-25T10:00:00Z"));
    const limiter = createRateLimiter(makeConfig(), silentLog);
    const res = limiter.checkAffordability({ category: "invitation_write", cost: 1 });
    expect(res.ok).toBe(false);
    expect(res.blockingReason).toMatch(/Outside working hours/);
    // Next Mon 09:00 UTC.
    expect(res.retryAt).toBe("2026-04-27T09:00:00.000Z");
  });
});

describe("report.workingHours.nextOkAt + spacingReadyAt + cooldown.readyAt", () => {
  let dir: string;

  beforeEach(() => {
    dir = useTempStorage();
    vi.useFakeTimers({ now: WED_10AM });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupStorage(dir);
  });

  it("workingHours.nextOkAt is null during the window, ISO outside", () => {
    const limiter = createRateLimiter(makeConfig(), silentLog);
    const inWindow = limiter.report();
    expect(inWindow.workingHours.ok).toBe(true);
    expect(inWindow.workingHours.nextOkAt).toBeNull();

    vi.setSystemTime(new Date("2026-04-22T22:00:00Z")); // past 18:00
    const outWindow = limiter.report();
    expect(outWindow.workingHours.ok).toBe(false);
    // Next open is 2026-04-23 (Thu) 09:00 UTC.
    expect(outWindow.workingHours.nextOkAt).toBe("2026-04-23T09:00:00.000Z");
  });

  it("category.spacingReadyAt reflects the pending spacing window", () => {
    const limiter = createRateLimiter(makeConfig(), silentLog);
    limiter.recordSuccess({ toolName: "inv", category: "invitation_write" });
    const r = limiter.report();
    const cat = r.categories.invitation_write!;
    expect(cat.secondsUntilSpacingCleared).toBeGreaterThan(0);
    expect(cat.spacingReadyAt).not.toBeNull();
  });

  it("cooldowns[key].readyAt reflects the 4h polling window", () => {
    const limiter = createRateLimiter(makeConfig(), silentLog);
    limiter.recordSuccess({
      toolName: "linkedin_list_relations",
      category: "relation_poll",
      cooldownKey: "linkedin_list_relations",
    });
    const r = limiter.report();
    const cd = r.cooldowns["linkedin_list_relations"]!;
    expect(cd.secondsRemaining).toBeGreaterThan(0);
    expect(cd.readyAt).not.toBeNull();
  });
});

describe("runner — isError flag on error results", () => {
  let dir: string;

  beforeEach(() => {
    dir = useTempStorage();
    vi.useFakeTimers({ now: WED_10AM });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupStorage(dir);
  });

  it("success result has no isError flag", async () => {
    const cfg = makeConfig();
    const limiter = createRateLimiter(cfg, silentLog);
    const ctx: ToolContext = { cfg, client: {} as never, limiter, log: silentLog };
    const res = await runUnipileTool(ctx, {
      toolName: "t",
      category: "profile_read",
      run: async () => ({ ok: true }),
    });
    expect(res.isError).toBeUndefined();
  });

  it("error result carries isError: true", async () => {
    const cfg = makeConfig();
    const limiter = createRateLimiter(cfg, silentLog);
    const ctx: ToolContext = { cfg, client: {} as never, limiter, log: silentLog };
    const res = await runUnipileTool(ctx, {
      toolName: "t",
      category: "profile_read",
      run: async () => {
        throw { body: { status: 422, type: "errors/invalid_recipient" } };
      },
    });
    expect(res.isError).toBe(true);
  });

  it("rate-limit block result carries isError: true", async () => {
    const cfg = makeConfig({
      accountTier: "classic",
      limits: { ...makeConfig().limits, profileReadsPerDay: 1 },
    });
    const limiter = createRateLimiter(cfg, silentLog);
    const ctx: ToolContext = { cfg, client: {} as never, limiter, log: silentLog };
    await runUnipileTool(ctx, {
      toolName: "t",
      category: "profile_read",
      run: async () => ({}),
    });
    const res = await runUnipileTool(ctx, {
      toolName: "t",
      category: "profile_read",
      run: async () => ({}),
    });
    expect(res.isError).toBe(true);
  });
});
