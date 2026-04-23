import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../src/rateLimit/index.js";
import { registerMessagingTools } from "../src/tools/messaging.js";
import type { ToolContext } from "../src/tools/runner.js";
import { cleanupStorage, makeConfig, silentLog, useTempStorage } from "./helpers.js";

const WED_10AM = new Date("2026-04-22T10:00:00Z");

type ToolLike = {
  name: string;
  execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }>;
};

/**
 * Build a minimal harness: collect every tool the plugin registers, and stub
 * the Unipile client so `startNewChat` captures its arguments rather than
 * calling the network.
 */
interface Harness {
  tools: Map<string, ToolLike>;
  readonly lastStartArgs: { base: unknown; options: unknown } | null;
}

function harness(cfgOverrides: Partial<ReturnType<typeof makeConfig>> = {}): Harness {
  const cfg = makeConfig(cfgOverrides);
  const limiter = createRateLimiter(cfg, silentLog);
  const tools = new Map<string, ToolLike>();
  const state = { lastStartArgs: null as { base: unknown; options: unknown } | null };

  const client = {
    messaging: {
      startNewChat: async (args: Record<string, unknown>) => {
        const { options, ...base } = args;
        state.lastStartArgs = { base, options };
        return { chat_id: "chat-xyz" };
      },
      sendMessage: async (_args: unknown) => ({ ok: true }),
      getAllChats: async (_args: unknown) => ({ items: [] }),
      getAllMessagesFromChat: async (_args: unknown) => ({ items: [] }),
      getAllMessagesFromAttendee: async (_args: unknown) => ({ items: [] }),
    },
  } as unknown as ToolContext["client"];

  const api = {
    registerTool: (tool: ToolLike) => {
      tools.set(tool.name, tool);
    },
  } as unknown as Parameters<typeof registerMessagingTools>[0];

  registerMessagingTools(api, { cfg, client, limiter, log: silentLog });
  return {
    tools,
    get lastStartArgs() {
      return state.lastStartArgs;
    },
  };
}

describe("linkedin_start_chat — InMail routing", () => {
  let dir: string;

  beforeEach(() => {
    dir = useTempStorage();
    vi.useFakeTimers({ now: WED_10AM });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupStorage(dir);
  });

  it("inmail=true forces the classic API on a Sales Navigator account", async () => {
    const h = harness({ accountTier: "sales_navigator" });
    const tool = h.tools.get("linkedin_start_chat")!;
    await tool.execute("id-1", {
      attendeeProviderIds: ["urn:li:member:123"],
      text: "Hi, wanted to reach out.",
      subject: "Quick intro",
      inmail: true,
    });
    expect(
      (h.lastStartArgs!.options as { linkedin: { api: string; inmail?: boolean } }).linkedin,
    ).toEqual({ api: "classic", inmail: true });
  });

  it("inmail=true still routes via classic even if caller passed searchType=sales_navigator", async () => {
    const h = harness({ accountTier: "sales_navigator" });
    const tool = h.tools.get("linkedin_start_chat")!;
    await tool.execute("id-2", {
      attendeeProviderIds: ["urn:li:member:123"],
      text: "Hello",
      searchType: "sales_navigator",
      inmail: true,
    });
    expect((h.lastStartArgs!.options as { linkedin: { api: string } }).linkedin.api).toBe(
      "classic",
    );
  });

  it("without inmail, SN accounts still default to the sales_navigator API", async () => {
    const h = harness({ accountTier: "sales_navigator" });
    const tool = h.tools.get("linkedin_start_chat")!;
    await tool.execute("id-3", {
      attendeeProviderIds: ["urn:li:member:123"],
      text: "Hello",
    });
    expect((h.lastStartArgs!.options as { linkedin: { api: string } }).linkedin.api).toBe(
      "sales_navigator",
    );
  });

  it("classic account without inmail routes via classic with no inmail flag", async () => {
    const h = harness({ accountTier: "classic" });
    const tool = h.tools.get("linkedin_start_chat")!;
    await tool.execute("id-4", {
      attendeeProviderIds: ["urn:li:member:123"],
      text: "Hello",
    });
    const opts = h.lastStartArgs!.options as { linkedin: Record<string, unknown> };
    expect(opts.linkedin.api).toBe("classic");
    expect(opts.linkedin.inmail).toBeUndefined();
  });
});
