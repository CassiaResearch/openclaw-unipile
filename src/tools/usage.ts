import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
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

export function registerUsageTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  api.registerTool(
    defineTool({
      name: "linkedin_usage_report",
      label: "LinkedIn: usage report",
      description:
        "Return the current rate-limit state for the connected LinkedIn account: per-category usage today / last 7 days / last 30 days (split into real `calls` vs. 429/500 `penalty`), remaining budgets, minimum-spacing countdowns, per-tool call counts for today, polling cooldowns per tool, working-hours status, and a ring of the most recent usage events. Use this to plan bursts or diagnose why another linkedin_* tool is blocked. Read-only, no guardrails, no budget cost.",
      parameters: UsageReportParams,
      execute: async (_id, params) => {
        const report = ctx.limiter.report({ eventLimit: params.eventLimit });
        return textResult(JSON.stringify(report, null, 2));
      },
    }),
  );
}
