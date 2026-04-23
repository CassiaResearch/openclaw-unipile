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
        "Diagnose why a linkedin_* tool is blocked, or plan a burst against the daily/weekly/monthly caps. Returns `{ workingHours: { ok, window, nextOkAt }, categories: { <cat>: { today/week/month usage+remaining, spacingReadyAt }, ... }, cooldowns: { <toolName>: { readyAt } }, recentEvents }`. Read-only, no budget cost.",
      parameters: UsageReportParams,
      execute: async (_id, params) => {
        const report = ctx.limiter.report({ eventLimit: params.eventLimit });
        return textResult(JSON.stringify(report));
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_check_budget",
      label: "LinkedIn: pre-flight budget check",
      description:
        "Pre-flight: would a call of `{category, cost}` pass the gate right now? Returns `{ ok, blockingReason, blockingCode, retryAt, remaining: { today, week, month } }`. Use before a batch — e.g. 'can I send 30 invites?' → `{ category: 'invitation_write', cost: 30 }`; the response tells you whether the daily cap fits and when it resets. Read-only, no budget cost, does NOT reserve. `blockingCode` is one of working_hours / budget_exhausted / spacing / cooldown.",
      parameters: CheckBudgetParams,
      execute: async (_id, params) => {
        const result = ctx.limiter.checkAffordability({
          category: params.category as RateCategory,
          cost: params.cost,
          cooldownKey: params.cooldownKey,
        });
        return textResult(JSON.stringify(result));
      },
    }),
  );
}
