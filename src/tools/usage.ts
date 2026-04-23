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
        "Diagnose why a linkedin_* tool is blocked, or plan a burst against the daily/weekly/monthly caps. Returns per-category usage, remaining budgets, active spacing and polling cooldowns, working-hours status, and recent usage events. Read-only, no budget cost.",
      parameters: UsageReportParams,
      execute: async (_id, params) => {
        const report = ctx.limiter.report({ eventLimit: params.eventLimit });
        return textResult(JSON.stringify(report, null, 2));
      },
    }),
  );
}
