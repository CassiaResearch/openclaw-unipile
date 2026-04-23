import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { compact, defineTool, runUnipileTool, type ToolContext } from "./runner.js";

const SearchType = Type.Union(
  [Type.Literal("sales_navigator"), Type.Literal("recruiter"), Type.Literal("classic")],
  {
    description:
      "Which LinkedIn API variant to use. Defaults to sales_navigator for Sales Nav / Recruiter accounts, classic otherwise.",
  },
);

const GetOwnProfileParams = Type.Object({}, { additionalProperties: false });

const GetProfileParams = Type.Object(
  {
    identifier: Type.String({
      description: "LinkedIn public identifier (slug) or provider_id.",
    }),
    searchType: Type.Optional(SearchType),
  },
  { additionalProperties: false },
);

const GetCompanyParams = Type.Object(
  {
    identifier: Type.String({
      description: "LinkedIn company public identifier or provider_id.",
    }),
  },
  { additionalProperties: false },
);

export function registerProfileTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { cfg, client } = ctx;
  const salesLike = cfg.accountTier === "sales_navigator" || cfg.accountTier === "recruiter";

  api.registerTool(
    defineTool({
      name: "linkedin_get_own_profile",
      label: "LinkedIn: get own profile",
      description:
        "Returns the profile of the currently connected LinkedIn account (name, headline, premium status, seats). No parameters.",
      parameters: GetOwnProfileParams,
      execute: async () =>
        runUnipileTool(ctx, {
          toolName: "linkedin_get_own_profile",
          category: "default",
          run: () => client.users.getOwnProfile(cfg.accountId),
        }),
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_get_profile",
      label: "LinkedIn: get profile",
      description:
        "Retrieve a LinkedIn profile by public identifier (e.g. 'elonmusk') or provider_id. Defaults to the Sales Navigator API variant when the connected account supports it, which returns richer data. Pass searchType='classic' to force the standard LinkedIn view.",
      parameters: GetProfileParams,
      execute: async (_id, params) => {
        const effectiveType = params.searchType ?? (salesLike ? "sales_navigator" : "classic");
        const linkedin_api = effectiveType === "classic" ? undefined : effectiveType;

        return runUnipileTool(ctx, {
          toolName: "linkedin_get_profile",
          category: "profile_read",
          run: () =>
            client.users.getProfile(
              compact({
                account_id: cfg.accountId,
                identifier: params.identifier,
                linkedin_api,
              }),
            ),
        });
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_get_company",
      label: "LinkedIn: get company profile",
      description:
        "Retrieve a LinkedIn company profile by company public identifier or provider_id.",
      parameters: GetCompanyParams,
      execute: async (_id, params) =>
        runUnipileTool(ctx, {
          toolName: "linkedin_get_company",
          category: "profile_read",
          run: () =>
            client.users.getCompanyProfile({
              account_id: cfg.accountId,
              identifier: params.identifier,
            }),
        }),
    }),
  );
}
