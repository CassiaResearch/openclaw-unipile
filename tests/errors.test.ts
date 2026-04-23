import { describe, expect, it } from "vitest";
import { inspectError, isIndeterminateSend, isRatePenalty, toToolError } from "../src/errors.js";

describe("inspectError", () => {
  it("extracts status + type from Unipile SDK body shape", () => {
    const err = { body: { status: 429, type: "errors/too_many_requests", detail: "slow down" } };
    const info = inspectError(err);
    expect(info.status).toBe(429);
    expect(info.type).toBe("errors/too_many_requests");
    expect(info.bodyText).toContain("errors/too_many_requests");
  });

  it("falls back to response.status (axios shape)", () => {
    const err = { response: { status: 500, data: { detail: "boom" } } };
    expect(inspectError(err).status).toBe(500);
  });

  it("returns undefined fields for plain Error / string / null", () => {
    expect(inspectError(new Error("x"))).toEqual({
      status: undefined,
      type: undefined,
      bodyText: "",
    });
    expect(inspectError("boom")).toEqual({
      status: undefined,
      type: undefined,
      bodyText: "",
    });
    expect(inspectError(null)).toEqual({
      status: undefined,
      type: undefined,
      bodyText: "",
    });
  });
});

describe("toToolError", () => {
  it.each<[string, unknown, string | RegExp]>([
    [
      "logged-out account → reconnect message",
      { body: { status: 401, type: "errors/disconnected_account" } },
      /logged out of Unipile/,
    ],
    [
      "premium missing → required-access message",
      { body: { status: 403, type: "errors/feature_not_subscribed" } },
      /missing the required access/,
    ],
    [
      "checkpoint → resolve-via-dashboard message",
      { body: { status: 401, type: "errors/checkpoint_error" } },
      /requesting verification/,
    ],
    [
      "cannot_resend_yet → invitation cooldown",
      { body: { status: 422, type: "errors/cannot_resend_yet" } },
      /invitation cooldown/,
    ],
    [
      "already_connected → use send_message",
      { body: { status: 422, type: "errors/already_connected" } },
      /already connected/,
    ],
    [
      "insufficient_credits → out of InMail credits",
      { body: { status: 422, type: "errors/insufficient_credits" } },
      /InMail credits/,
    ],
    [
      "request_timeout → verify before retry",
      { body: { status: 504, type: "errors/request_timeout" } },
      /may or may not have landed/,
    ],
    ["429 → rate limit", { body: { status: 429, type: "errors/too_many_requests" } }, /rate limit/],
    [
      "unknown type + 401 → generic auth message",
      { body: { status: 401, type: "errors/made_up_new_slug" } },
      /unauthorized/,
    ],
  ])("%s", (_name, err, expected) => {
    expect(toToolError(err, "tool_x")).toMatch(expected);
  });
});

describe("isRatePenalty", () => {
  it.each([429, 500, 502, 503])("returns true for HTTP %i", (status) => {
    expect(isRatePenalty({ body: { status } })).toBe(true);
  });

  it.each(["errors/too_many_requests", "errors/limit_exceeded", "errors/provider_error"])(
    "returns true for type %s",
    (type) => {
      expect(isRatePenalty({ body: { status: 418, type } })).toBe(true);
    },
  );

  it("returns false for unrelated errors", () => {
    expect(isRatePenalty(new Error("nope"))).toBe(false);
    expect(isRatePenalty({ body: { status: 400 } })).toBe(false);
  });
});

describe("isIndeterminateSend", () => {
  const timeout = { body: { status: 504, type: "errors/request_timeout" } };

  it("returns true only for write categories on timeout", () => {
    expect(isIndeterminateSend(timeout, "invitation_write")).toBe(true);
    expect(isIndeterminateSend(timeout, "message_write")).toBe(true);
  });

  it("returns false for read/cache categories even on timeout", () => {
    expect(isIndeterminateSend(timeout, "profile_read")).toBe(false);
    expect(isIndeterminateSend(timeout, "search_results")).toBe(false);
    expect(isIndeterminateSend(timeout, "cached_read")).toBe(false);
  });

  it("returns false for non-timeout errors on writes", () => {
    expect(
      isIndeterminateSend(
        { body: { status: 422, type: "errors/invalid_message" } },
        "message_write",
      ),
    ).toBe(false);
  });
});
