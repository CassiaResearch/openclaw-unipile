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

export const TOOL_COUNT = 17;

export function registerAllTools(
  api: OpenClawPluginApi,
  cfg: UnipileConfig,
  client: UnipileClient,
  limiter: RateLimiter,
  log: Log,
): void {
  const ctx: ToolContext = { cfg, client, limiter, log };
  registerProfileTools(api, ctx);
  registerSearchTools(api, ctx);
  registerMessagingTools(api, ctx);
  registerInvitationTools(api, ctx);
  registerRelationTools(api, ctx);
  registerUsageTools(api, ctx);
}
