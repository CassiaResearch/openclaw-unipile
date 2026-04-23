import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnipileClient } from "unipile-node-sdk";
import type { Log } from "../log.js";
import type { RateLimiter } from "../rateLimit/index.js";
import type { UnipileConfig } from "../types.js";
import { registerInvitationTools } from "./invitations.js";
import { registerMessagingTools } from "./messaging.js";
import { registerProfileTools } from "./profile.js";
import { registerRelationTools } from "./relations.js";
import { registerSearchTools } from "./search.js";
import { registerUsageTools } from "./usage.js";
import type { ToolContext } from "./runner.js";

/** Number of registered tools from the most recent registerAllTools() call. */
export function registerAllTools(
  api: OpenClawPluginApi,
  cfg: UnipileConfig,
  client: UnipileClient,
  limiter: RateLimiter,
  log: Log,
): number {
  let count = 0;
  const countingApi: OpenClawPluginApi = {
    ...api,
    registerTool: ((tool, opts) => {
      count += 1;
      return api.registerTool(tool, opts);
    }) as OpenClawPluginApi["registerTool"],
  };
  const ctx: ToolContext = { cfg, client, limiter, log };
  registerProfileTools(countingApi, ctx);
  registerSearchTools(countingApi, ctx);
  registerMessagingTools(countingApi, ctx);
  registerInvitationTools(countingApi, ctx);
  registerRelationTools(countingApi, ctx);
  registerUsageTools(countingApi, ctx);
  return count;
}
