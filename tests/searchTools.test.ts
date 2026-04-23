import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../src/rateLimit/index.js";
import { registerSearchTools } from "../src/tools/search.js";
import type { ToolContext } from "../src/tools/runner.js";
import { cleanupStorage, makeConfig, silentLog, unwrapToolText, useTempStorage } from "./helpers.js";

const WED_10AM = new Date("2026-04-22T10:00:00Z");

type ToolLike = {
  name: string;
  execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }>;
};

/**
 * Fake item shape chosen to include a mix of fields we keep in compact mode
 * (provider_id, headline, network_distance, …) and verbose fields we drop
 * (education, positions, connection count, embedded recruiter profile).
 */
const fakeItem = {
  provider_id: "urn:li:member:42",
  public_identifier: "jane-doe",
  first_name: "Jane",
  last_name: "Doe",
  headline: "VP of Whatever",
  location: "San Francisco, CA",
  current_position: "VP Whatever",
  current_company: "Acme",
  network_distance: "DISTANCE_2",
  pending_invitation: false,
  open_profile: true,
  premium: true,
  education: [
    { school: "A", degree: "BA", years: "2000-2004" },
    { school: "B", degree: "MBA", years: "2010-2012" },
  ],
  positions: Array.from({ length: 8 }, (_, i) => ({ title: `Role ${i}`, company: `Co ${i}` })),
  num_connections: 500,
  skills: Array.from({ length: 25 }, (_, i) => ({ name: `Skill ${i}` })),
};

function harness() {
  const cfg = makeConfig();
  const limiter = createRateLimiter(cfg, silentLog);
  const tools = new Map<string, ToolLike>();

  const lastQuery = { body: null as unknown, params: null as unknown };
  const client = {
    request: {
      send: async (args: { body: unknown; parameters: unknown }) => {
        lastQuery.body = args.body;
        lastQuery.params = args.parameters;
        return { items: [fakeItem, fakeItem], cursor: "c1", paging: { total_count: 2 } };
      },
    },
  } as unknown as ToolContext["client"];

  const api = {
    registerTool: (tool: ToolLike) => {
      tools.set(tool.name, tool);
    },
  } as unknown as Parameters<typeof registerSearchTools>[0];

  registerSearchTools(api, { cfg, client, limiter, log: silentLog });
  return { tools, lastQuery };
}

describe("linkedin_search — compact projection", () => {
  let dir: string;

  beforeEach(() => {
    dir = useTempStorage();
    vi.useFakeTimers({ now: WED_10AM });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupStorage(dir);
  });

  it("without `compact`, returns the full upstream item", async () => {
    const h = harness();
    const tool = h.tools.get("linkedin_search")!;
    const res = await tool.execute("id-1", { keywords: "vp" });
    const parsed = JSON.parse(unwrapToolText(res.content[0]!.text)) as {
      items: Array<Record<string, unknown>>;
    };
    expect(parsed.items[0]!.education).toBeDefined();
    expect(parsed.items[0]!.positions).toBeDefined();
    expect(parsed.items[0]!.skills).toBeDefined();
  });

  it("with `compact: true`, items are projected to the outreach fields only", async () => {
    const h = harness();
    const tool = h.tools.get("linkedin_search")!;
    const res = await tool.execute("id-2", { keywords: "vp", compact: true });
    const parsed = JSON.parse(unwrapToolText(res.content[0]!.text)) as {
      items: Array<Record<string, unknown>>;
    };
    const item = parsed.items[0]!;

    // Kept
    expect(item.provider_id).toBe("urn:li:member:42");
    expect(item.headline).toBe("VP of Whatever");
    expect(item.network_distance).toBe("DISTANCE_2");
    expect(item.pending_invitation).toBe(false);
    expect(item.open_profile).toBe(true);

    // Dropped
    expect(item.education).toBeUndefined();
    expect(item.positions).toBeUndefined();
    expect(item.skills).toBeUndefined();
    expect(item.num_connections).toBeUndefined();

    // Envelope fields preserved
    expect(parsed.items).toHaveLength(2);
    expect((parsed as unknown as { cursor: string }).cursor).toBe("c1");
  });

  it("sends account_id in query and api in body (keyword mode)", async () => {
    // Regression for the original bug: account_id must be a query param or
    // Unipile rejects with `400 /account_id Required property`.
    // Per Unipile's OpenAPI spec, `api` is the body-level discriminator
    // between 9 body variants (Classic/SN/Recruiter × People/Companies/...),
    // NOT a query param. An earlier over-correction put `api` in the query.
    const h = harness();
    const tool = h.tools.get("linkedin_search")!;
    await tool.execute("id-q", { keywords: "vp", searchType: "sales_navigator" });

    const params = h.lastQuery.params as Record<string, string>;
    const body = h.lastQuery.body as Record<string, unknown>;

    // account_id: query only.
    expect(params.account_id).toBe("test-account");
    expect(body.account_id).toBeUndefined();

    // api: body only (discriminator between anyOf body variants).
    expect(body.api).toBe("sales_navigator");
    expect(params.api).toBeUndefined();

    // Search content in body.
    expect(body.keywords).toBe("vp");
  });

  it("URL mode omits `api` from the body (URL encodes the variant)", async () => {
    // The "Search from URL" body variant in Unipile's spec doesn't include
    // `api` — the URL itself tells Unipile which LinkedIn product to parse.
    // Sending api alongside a URL is redundant at best and contradictory at
    // worst (e.g. classic URL with api=sales_navigator).
    const h = harness();
    const tool = h.tools.get("linkedin_search")!;
    await tool.execute("id-u", {
      url: "https://www.linkedin.com/search/results/people/?keywords=vp",
      searchType: "sales_navigator",
    });

    const body = h.lastQuery.body as Record<string, unknown>;
    expect(body.url).toMatch(/linkedin\.com/);
    expect(body.api).toBeUndefined();
  });

  it("pagination cursor goes in the body, not the query", async () => {
    // Per Unipile's spec, cursor has a dedicated body variant for continuing
    // pagination. Our earlier code put it in the query, which — though also
    // documented — doesn't match the known-working caller pattern and risks
    // silent page-1-only behavior if Unipile prefers body.
    const h = harness();
    const tool = h.tools.get("linkedin_search")!;
    await tool.execute("id-c", { keywords: "vp", cursor: "page-2-cursor", limit: 50 });

    const params = h.lastQuery.params as Record<string, string>;
    const body = h.lastQuery.body as Record<string, unknown>;

    expect(body.cursor).toBe("page-2-cursor");
    expect(params.cursor).toBeUndefined();
    expect(params.limit).toBe("50");
  });

  it("rejects non-linkedin URLs with errorCode='invalid_target'", async () => {
    const h = harness();
    const tool = h.tools.get("linkedin_search")!;
    const res = (await tool.execute("id-3", {
      url: "https://evil.com/?x=linkedin.com",
    })) as unknown as { isError?: boolean; errorCode?: string; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.errorCode).toBe("invalid_target");
  });
});
