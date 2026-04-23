import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { compact, defineTool, runUnipileTool, textResult, type ToolContext } from "./runner.js";

const ListRelationsParams = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description:
          "Page size. Mutually exclusive with `cursor` (cursor encodes the original page size).",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        description:
          "Opaque pagination cursor from a prior response. Mutually exclusive with `limit`.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function registerRelationTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { cfg, client } = ctx;

  api.registerTool(
    defineTool({
      name: "linkedin_list_relations",
      label: "LinkedIn: list your connections",
      description:
        "List first-degree connections of the connected LinkedIn account. Subject to a 4 h polling cooldown — prefer paging large result sets in a single burst rather than polling at fixed intervals. Pass `limit` OR `cursor`, not both: the cursor already carries the page size from when it was issued.",
      parameters: ListRelationsParams,
      execute: async (_id, params) => {
        if (params.cursor && params.limit !== undefined) {
          return textResult(
            `[unipile:linkedin_list_relations] Pass either \`cursor\` or \`limit\`, not both. The cursor encodes the page size from the prior call.`,
          );
        }
        return runUnipileTool(ctx, {
          toolName: "linkedin_list_relations",
          category: "relation_poll",
          cooldownKey: "linkedin_list_relations",
          run: () =>
            params.cursor
              ? client.users.getAllRelations({
                  account_id: cfg.accountId,
                  cursor: params.cursor,
                })
              : client.users.getAllRelations(
                  compact({
                    account_id: cfg.accountId,
                    limit: params.limit,
                  }),
                ),
        });
      },
    }),
  );
}
