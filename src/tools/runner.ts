import type { Static, TSchema } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { UnipileClient } from "unipile-node-sdk";
import { UnipileLimitError, isIndeterminateSend, toToolError } from "../errors.js";
import type { Log } from "../log.js";
import type { RateLimiter } from "../rateLimit/index.js";
import type { RateCategory, UnipileConfig } from "../types.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}

export interface ToolContext {
  cfg: UnipileConfig;
  client: UnipileClient;
  limiter: RateLimiter;
  log: Log;
}

export interface ExecuteOptions<T> {
  toolName: string;
  category: RateCategory;
  reservedCost?: number;
  cooldownKey?: string;
  actualCost?: (result: T) => number;
  run: () => Promise<T>;
  /**
   * When set, the runner checks `payload` against prior sends recorded under
   * `key` and refuses the call if we've sent the same text before. On success
   * or indeterminate outcome, the hash is recorded. Skip for bypass/read
   * tools — this is strictly for write endpoints where LinkedIn flags
   * repeated identical bodies as automation.
   */
  dedup?: { key: string; payload: string };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: null };
}

function serialize(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable>";
  }
}

/**
 * Returned by `compact<T>`. Keys whose input type includes `undefined` become
 * optional (with `undefined` stripped from the value type); keys with a
 * fixed non-undefined type remain required. Avoids the boilerplate
 * `as { ... }` cast at every call site.
 */
type CompactOutput<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/**
 * Drop entries whose value is `undefined`. Used by tools to forward optional
 * params into SDK calls without writing `...(x !== undefined ? { x } : {})`
 * for every field.
 */
export function compact<T extends Record<string, unknown>>(obj: T): CompactOutput<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as CompactOutput<T>;
}

/**
 * Normalize user-supplied free text before it leaves the plugin. Collapses
 * CR/LF/CRLF line endings to `\n` and trims surrounding whitespace. Applied
 * to every outbound message body, invite note, and subject so what LinkedIn
 * stores matches what we and downstream consumers will compare against —
 * mixed `\r\n` vs `\n` silently breaks byte-for-byte equality.
 */
export function normalizeOutboundText(s: string): string {
  return s.replace(/\r\n|\r/g, "\n").trim();
}

/**
 * Shape of a tool definition keyed on its TypeBox parameter schema. Using a
 * helper (vs. inlining the literal) preserves `params` typing inside
 * `execute` — otherwise TS widens `TParameters` to `any` at the
 * `registerTool(tool: AnyAgentTool)` call site and the static type is lost.
 */
export interface UnipileToolDefinition<TParameters extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  execute: (toolCallId: string, params: Static<TParameters>) => Promise<ToolResult>;
}

export function defineTool<TParameters extends TSchema>(
  tool: UnipileToolDefinition<TParameters>,
): AnyAgentTool {
  // AnyAgentTool's execute drops the extra positional args (signal, onUpdate)
  // we don't use. Casting is safe because AgentToolResult and our ToolResult
  // share structure (content + details).
  return tool as unknown as AnyAgentTool;
}

export function runUnipileTool<T>(ctx: ToolContext, opts: ExecuteOptions<T>): Promise<ToolResult> {
  const { toolName, category, reservedCost = 1, cooldownKey, actualCost, run, dedup } = opts;
  const rule = ctx.limiter.getRule(category);

  const invoke = async (): Promise<ToolResult> => {
    if (dedup && ctx.limiter.isDuplicateSend(dedup.key, dedup.payload)) {
      const reason = `Duplicate message detected — the same text was already sent to this recipient. Rephrase before retrying; repeated identical bodies get flagged by LinkedIn as automation.`;
      ctx.limiter.recordBlocked({ toolName, category, reason });
      ctx.log.warn(`${toolName} blocked: duplicate payload`);
      return textResult(`[unipile:${toolName}] ${reason}`);
    }

    if (!rule.bypassAll) {
      try {
        await ctx.limiter.gate({ toolName, category, cost: reservedCost, cooldownKey });
      } catch (err) {
        if (err instanceof UnipileLimitError) {
          ctx.log.warn(`${toolName} blocked: ${err.message}`);
          return textResult(`[unipile:${toolName}] ${err.message}`);
        }
        throw err;
      }
    }

    const startedAt = Date.now();
    try {
      const result = await run();
      if (!rule.bypassAll) {
        const cost = actualCost ? Math.max(0, actualCost(result)) : reservedCost;
        ctx.limiter.recordSuccess({
          toolName,
          category,
          cost,
          cooldownKey,
          durationMs: Date.now() - startedAt,
        });
      }
      if (dedup) ctx.limiter.recordSend(dedup.key, dedup.payload);
      return textResult(serialize(result));
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const msg = toToolError(err, toolName);

      // Timed-out writes may still have landed on LinkedIn. Count against
      // budget (conservative) but flag as indeterminate so the agent verifies
      // before retrying — retrying blindly risks double-sending invites/DMs.
      if (!rule.bypassAll && isIndeterminateSend(err, category)) {
        ctx.limiter.recordSuccess({
          toolName,
          category,
          cost: reservedCost,
          cooldownKey,
          durationMs,
          indeterminate: true,
        });
        // Record dedup hash too — the message may have landed, so block
        // retries of the same text.
        if (dedup) ctx.limiter.recordSend(dedup.key, dedup.payload);
        ctx.log.warn(`${toolName} indeterminate: ${msg}`);
        return textResult(`[unipile:${toolName}] ${msg}`);
      }

      if (!rule.bypassAll) {
        ctx.limiter.recordFailure({ toolName, category, err, cooldownKey, durationMs });
      }
      ctx.log.warn(`${toolName} failed: ${msg}`);
      return textResult(`[unipile:${toolName}] ${msg}`);
    }
  };

  // Writes serialize globally to avoid concurrent same-account signals to
  // LinkedIn. Reads run in parallel — the daily/weekly/monthly caps still
  // protect the account from volume.
  return rule.serializeCalls ? ctx.limiter.runExclusive(invoke) : invoke();
}
