import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { defineTool, runUnipileTool, textResult, type ToolContext } from "./runner.js";

/**
 * Only LinkedIn hosts are accepted for the `url` passthrough. Unipile is
 * permissive; without this guard, an agent prompt-injected with an arbitrary
 * URL could steer the search call at an attacker-controlled host.
 */
function isLinkedInSearchUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "linkedin.com" || host.endsWith(".linkedin.com");
  } catch {
    return false;
  }
}

type RawSearchResponse = {
  items?: unknown[];
  cursor?: string | null;
  paging?: { total_count?: number };
};

type RawSearchParametersResponse = {
  object?: string;
  items?: Array<{ title?: string; id?: string }>;
  paging?: { page_count?: number };
};

const SearchType = Type.Union(
  [Type.Literal("sales_navigator"), Type.Literal("classic"), Type.Literal("recruiter")],
  {
    description: "LinkedIn search API variant. Defaults to sales_navigator when available.",
  },
);

const SearchCategory = Type.Union(
  [Type.Literal("people"), Type.Literal("companies"), Type.Literal("jobs"), Type.Literal("posts")],
  {
    description:
      "Coarse result category. Optional — Unipile infers from filters otherwise. 'posts' is classic-only.",
  },
);

const SearchParams = Type.Object(
  {
    url: Type.Optional(
      Type.String({
        description:
          "Paste a LinkedIn search URL from the browser (Sales Navigator or classic). When set, `filters`, `keywords`, and `category` are ignored and Unipile parses the URL directly. Still use `searchType` to match the URL's product, plus `limit` / `cursor` for pagination.",
      }),
    ),
    searchType: Type.Optional(SearchType),
    keywords: Type.Optional(
      Type.String({ description: "Free-text keywords (people or companies)." }),
    ),
    category: Type.Optional(SearchCategory),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description:
          "Max results per page (1-100). LinkedIn hard-caps total returned per query at 1000 (classic) or 2500 (Sales Nav / Recruiter).",
      }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Cursor from a previous response for pagination." }),
    ),
    filters: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Passthrough filter object. Shape varies by searchType. Common keys: 'location' (array of IDs), 'industry' ({include,exclude} arrays of IDs), 'company' ({include,exclude} of company IDs), 'network_distance' ([1,2,3]), 'role' (array of {keywords,priority,scope}), 'skills' (array of {id,priority}). Resolve human-readable names to LinkedIn IDs first via linkedin_search_parameters. `api` and `account_id` here are ignored — they are always injected from the tool context.",
      }),
    ),
  },
  { additionalProperties: false },
);

const ParameterDiscoveryType = Type.Union(
  [
    Type.Literal("LOCATION"),
    Type.Literal("INDUSTRY"),
    Type.Literal("COMPANY"),
    Type.Literal("SKILL"),
    Type.Literal("SCHOOL"),
    Type.Literal("LANGUAGE"),
    Type.Literal("SERVICE"),
  ],
  { description: "Which entity to resolve. LinkedIn keeps a separate ID space per type." },
);

const SearchParametersParams = Type.Object(
  {
    type: ParameterDiscoveryType,
    keywords: Type.String({
      description: "Free-text to look up (e.g. 'Los Angeles', 'Typescript', 'OpenAI').",
    }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
  },
  { additionalProperties: false },
);

export function registerSearchTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { cfg, client } = ctx;
  const salesLike = cfg.accountTier === "sales_navigator" || cfg.accountTier === "recruiter";

  api.registerTool(
    defineTool({
      name: "linkedin_search",
      label: "LinkedIn: search",
      description:
        "Search LinkedIn for people / companies / jobs / posts. Two modes: (a) paste a browser search URL via `url` and Unipile parses everything from it (must be an https://*.linkedin.com URL); (b) supply `keywords` / `category` / `filters`. Filter values must be LinkedIn internal IDs — resolve human-readable names via linkedin_search_parameters first. Each result item includes `provider_id` (the member URN needed by linkedin_send_invitation / linkedin_start_chat / linkedin_get_profile), `network_distance` (DISTANCE_1/2/3/OUT_OF_NETWORK), `pending_invitation`, and `open_profile` — branch outreach on these. Budget cost is the number of results returned, not the number of calls; narrow queries are cheap. LinkedIn caps total results per query at 1000 (classic) or 2500 (Sales Nav / Recruiter).",
      parameters: SearchParams,
      execute: async (_id, params) => {
        const effectiveType = params.searchType ?? (salesLike ? "sales_navigator" : "classic");

        const body: Record<string, unknown> = {};
        if (params.url && params.url.trim()) {
          const trimmed = params.url.trim();
          if (!isLinkedInSearchUrl(trimmed)) {
            return textResult(
              `[unipile:linkedin_search] Refusing to search non-LinkedIn URL. 'url' must be an https://*.linkedin.com search URL.`,
            );
          }
          body.url = trimmed;
        } else {
          if (params.filters) {
            Object.assign(body, params.filters);
          }
          if (params.keywords && params.keywords.trim()) {
            body.keywords = params.keywords.trim();
          }
          if (params.category) {
            body.category = params.category;
          }
        }
        // Force api + account_id last so filters/url can't override them.
        body.api = effectiveType;
        body.account_id = cfg.accountId;

        const query: Record<string, string> = {};
        if (params.limit !== undefined) query.limit = String(params.limit);
        if (params.cursor) query.cursor = params.cursor;

        const reservedCost = Math.min(params.limit ?? 10, 100);

        return runUnipileTool(ctx, {
          toolName: "linkedin_search",
          category: "search_results",
          reservedCost,
          actualCost: (res: RawSearchResponse) =>
            Array.isArray(res?.items) ? res.items.length : 0,
          run: () =>
            client.request.send<RawSearchResponse>({
              method: "POST",
              path: ["linkedin", "search"],
              body,
              parameters: query,
            }),
        });
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_search_parameters",
      label: "LinkedIn: resolve search filter IDs",
      description:
        "Resolve a human-readable name to the LinkedIn internal ID needed by linkedin_search filters. Call this before linkedin_search whenever you have a location / industry / company / skill name and need to filter by it — LinkedIn requires IDs, not names. Returns up to `limit` matches as `{ title, id }` objects. Counts against the default per-day budget.",
      parameters: SearchParametersParams,
      execute: async (_id, params) => {
        const query: Record<string, string> = {
          account_id: cfg.accountId,
          type: params.type,
          keywords: params.keywords,
        };
        if (params.limit !== undefined) query.limit = String(params.limit);

        return runUnipileTool(ctx, {
          toolName: "linkedin_search_parameters",
          category: "default",
          run: () =>
            client.request.send<RawSearchParametersResponse>({
              method: "GET",
              path: ["linkedin", "search", "parameters"],
              parameters: query,
            }),
        });
      },
    }),
  );
}
