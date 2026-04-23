import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../src/errors.js";
import { createRateLimiter } from "../src/rateLimit/index.js";
import { runUnipileTool, type ToolContext } from "../src/tools/runner.js";
import { cleanupStorage, makeConfig, silentLog, useTempStorage } from "./helpers.js";

const WED_10AM = new Date("2026-04-22T10:00:00Z");

describe("classifyError — maps Unipile error shapes to stable codes", () => {
  it.each([
    ["429", { body: { status: 429, type: "errors/too_many_requests" } }, "rate_limit"],
    ["504", { body: { status: 504, type: "errors/request_timeout" } }, "timeout"],
    [
      "account logged out",
      { body: { status: 401, type: "errors/disconnected_account" } },
      "account_disconnected",
    ],
    ["captcha", { body: { status: 401, type: "errors/checkpoint_error" } }, "checkpoint"],
    [
      "premium required",
      { body: { status: 403, type: "errors/feature_not_subscribed" } },
      "premium_required",
    ],
    [
      "already connected",
      { body: { status: 422, type: "errors/already_connected" } },
      "already_connected",
    ],
    [
      "pending invitation",
      { body: { status: 422, type: "errors/cannot_resend_yet" } },
      "invitation_pending",
    ],
    [
      "not connected",
      { body: { status: 422, type: "errors/no_connection_with_recipient" } },
      "not_connected",
    ],
    [
      "inmail not allowed",
      { body: { status: 422, type: "errors/not_allowed_inmail" } },
      "inmail_not_allowed",
    ],
    [
      "out of credits",
      { body: { status: 422, type: "errors/insufficient_credits" } },
      "insufficient_credits",
    ],
    ["not found", { body: { status: 404, type: "errors/resource_not_found" } }, "not_found"],
    ["upstream 503", { body: { status: 503 } }, "upstream_error"],
    ["unknown shape", { weird: "thing" }, "unipile_error"],
  ])("%s → %s", (_label, err, expected) => {
    expect(classifyError(err)).toBe(expected);
  });
});

describe("runner — errorCode on ToolResult", () => {
  let dir: string;

  beforeEach(() => {
    dir = useTempStorage();
    vi.useFakeTimers({ now: WED_10AM });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupStorage(dir);
  });

  it("rate-limit block surfaces errorCode='budget_exhausted'", async () => {
    const cfg = makeConfig({
      accountTier: "classic",
      limits: { ...makeConfig().limits, profileReadsPerDay: 1 },
    });
    const limiter = createRateLimiter(cfg, silentLog);
    const ctx: ToolContext = { cfg, client: {} as never, limiter, log: silentLog };
    await runUnipileTool(ctx, {
      toolName: "p",
      category: "profile_read",
      run: async () => ({}),
    });
    const blocked = await runUnipileTool(ctx, {
      toolName: "p",
      category: "profile_read",
      run: async () => ({}),
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.errorCode).toBe("budget_exhausted");
  });

  it("Saturday write surfaces errorCode='working_hours'", async () => {
    vi.setSystemTime(new Date("2026-04-25T10:00:00Z"));
    const cfg = makeConfig();
    const limiter = createRateLimiter(cfg, silentLog);
    const ctx: ToolContext = { cfg, client: {} as never, limiter, log: silentLog };
    const res = await runUnipileTool(ctx, {
      toolName: "inv",
      category: "invitation_write",
      run: async () => ({}),
    });
    expect(res.errorCode).toBe("working_hours");
  });

  it("504 on write is errorCode='timeout' and details carries indeterminate: true", async () => {
    const cfg = makeConfig();
    const limiter = createRateLimiter(cfg, silentLog);
    const ctx: ToolContext = { cfg, client: {} as never, limiter, log: silentLog };
    const res = await runUnipileTool(ctx, {
      toolName: "linkedin_send_message",
      category: "message_write",
      run: async () => {
        throw { body: { status: 504, type: "errors/request_timeout" } };
      },
    });
    expect(res.errorCode).toBe("timeout");
    expect(res.details).toEqual({ indeterminate: true });
  });

  it("already_connected maps to errorCode='already_connected'", async () => {
    const cfg = makeConfig();
    const limiter = createRateLimiter(cfg, silentLog);
    const ctx: ToolContext = { cfg, client: {} as never, limiter, log: silentLog };
    const res = await runUnipileTool(ctx, {
      toolName: "linkedin_send_invitation",
      category: "invitation_write",
      run: async () => {
        throw { body: { status: 422, type: "errors/already_connected" } };
      },
    });
    expect(res.errorCode).toBe("already_connected");
  });

  it("successful result has no errorCode", async () => {
    const cfg = makeConfig();
    const limiter = createRateLimiter(cfg, silentLog);
    const ctx: ToolContext = { cfg, client: {} as never, limiter, log: silentLog };
    const res = await runUnipileTool(ctx, {
      toolName: "p",
      category: "profile_read",
      run: async () => ({ ok: true }),
    });
    expect(res.errorCode).toBeUndefined();
  });
});

describe("checkAffordability — blockingCode", () => {
  let dir: string;

  beforeEach(() => {
    dir = useTempStorage();
    vi.useFakeTimers({ now: WED_10AM });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupStorage(dir);
  });

  it("ok=true has blockingCode=null", () => {
    const limiter = createRateLimiter(makeConfig(), silentLog);
    expect(limiter.checkAffordability({ category: "invitation_write" }).blockingCode).toBeNull();
  });

  it("Saturday write returns blockingCode='working_hours'", () => {
    vi.setSystemTime(new Date("2026-04-25T10:00:00Z"));
    const limiter = createRateLimiter(makeConfig(), silentLog);
    const res = limiter.checkAffordability({ category: "invitation_write" });
    expect(res.blockingCode).toBe("working_hours");
  });

  it("exhausted daily cap returns blockingCode='budget_exhausted'", () => {
    const limiter = createRateLimiter(
      makeConfig({
        limits: { ...makeConfig().limits, invitationsPerDay: 1 },
        pacing: { ...makeConfig().pacing, invitationMinSpacingSec: 0 },
      }),
      silentLog,
    );
    limiter.recordSuccess({ toolName: "inv", category: "invitation_write" });
    expect(limiter.checkAffordability({ category: "invitation_write" }).blockingCode).toBe(
      "budget_exhausted",
    );
  });

  it("spacing window returns blockingCode='spacing'", () => {
    const limiter = createRateLimiter(makeConfig(), silentLog);
    limiter.recordSuccess({ toolName: "inv", category: "invitation_write" });
    expect(limiter.checkAffordability({ category: "invitation_write" }).blockingCode).toBe(
      "spacing",
    );
  });

  it("polling cooldown returns blockingCode='cooldown'", () => {
    const limiter = createRateLimiter(makeConfig(), silentLog);
    limiter.recordSuccess({
      toolName: "linkedin_list_relations",
      category: "relation_poll",
      cooldownKey: "linkedin_list_relations",
    });
    expect(
      limiter.checkAffordability({
        category: "relation_poll",
        cooldownKey: "linkedin_list_relations",
      }).blockingCode,
    ).toBe("cooldown");
  });
});
