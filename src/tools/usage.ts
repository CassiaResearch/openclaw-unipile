import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { RateCategory } from "../types.js";
import { defineTool, textResult, type ToolContext } from "./runner.js";

const UsageReportParams = Type.Object(
  {
    eventLimit: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 500,
        default: 20,
        description:
          "How many of the most recent usage events to include in `recentEvents` (default 20, max 500).",
      }),
    ),
  },
  { additionalProperties: false },
);

const CheckBudgetCategory = Type.Union(
  [
    Type.Literal("invitation_write"),
    Type.Literal("message_write"),
    Type.Literal("profile_read"),
    Type.Literal("search_results"),
    Type.Literal("relation_poll"),
    Type.Literal("default"),
  ],
  {
    description:
      "Rate-limit category — matches the category each tool charges against: invitation_write (linkedin_send_invitation, linkedin_handle_invitation), message_write (linkedin_send_message, linkedin_start_chat), profile_read (linkedin_get_profile, linkedin_get_company), search_results (linkedin_search), relation_poll (linkedin_list_relations, linkedin_list_invitations_sent/received), default (everything else).",
  },
);

const CheckBudgetParams = Type.Object(
  {
    category: CheckBudgetCategory,
    cost: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10000,
        default: 1,
        description:
          "Intended cost. Use 1 for most tools; for linkedin_search use the expected number of results (≥ `limit`).",
      }),
    ),
    cooldownKey: Type.Optional(
      Type.String({
        description:
          "Set this to the polling tool name when checking relation_poll (e.g. 'linkedin_list_relations') — each polling tool has its own 4 h cooldown.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function registerUsageTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  api.registerTool(
    defineTool({
      name: "linkedin_usage_report",
      label: "LinkedIn: usage report",
      description:
        "Diagnose why a linkedin_* tool is blocked, or plan a burst against the daily/weekly/monthly caps. Returns per-category usage, remaining budgets, active spacing and polling cooldowns (each with an absolute `readyAt` ISO timestamp), working-hours status with `nextOkAt`, and recent usage events. Read-only, no budget cost.",
      parameters: UsageReportParams,
      execute: async (_id, params) => {
        const report = ctx.limiter.report({ eventLimit: params.eventLimit });
        return textResult(JSON.stringify(report, null, 2));
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_check_budget",
      label: "LinkedIn: pre-flight budget check",
      description:
        "Ask whether a single call in a given category would pass right now — before actually making it. Returns `ok`, a `blockingReason` if not, a `retryAt` ISO timestamp when applicable, and per-window `remaining` headroom. Useful before planning a batch (e.g. 'can I invite 30 people today?' → call with cost=30 to see if the daily cap allows it). Read-only, no budget cost. Does NOT reserve anything.",
      parameters: CheckBudgetParams,
      execute: async (_id, params) => {
        const result = ctx.limiter.checkAffordability({
          category: params.category as RateCategory,
          cost: params.cost,
          cooldownKey: params.cooldownKey,
        });
        return textResult(JSON.stringify(result, null, 2));
      },
    }),
  );
}
