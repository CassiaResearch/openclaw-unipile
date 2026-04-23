import type { Static, TSchema } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import type { UnipileClient } from "unipile-node-sdk";
import {
  UnipileLimitError,
  classifyError,
  isIndeterminateSend,
  toToolError,
  type UnipileErrorCode,
} from "../errors.js";
import type { Log } from "../log.js";
import type { ProgressUpdate, RateLimiter } from "../rateLimit/index.js";
import type { RateCategory, UnipileConfig } from "../types.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
  /**
   * MCP-style flag telling the host that `content` describes an error, not a
   * successful result. Agents can branch on this without having to parse the
   * `[unipile:tool]` prefix text. Absent = success.
   */
  isError?: boolean;
  /**
   * Structured classification when `isError` is set. Lets the agent branch
   * on the error class (rate_limit / not_connected / timeout / ...) without
   * regex-parsing the free-form message text. See UnipileErrorCode.
   */
  errorCode?: UnipileErrorCode;
}

/**
 * Progress-update callback the agent harness passes as the fourth positional
 * argument to `execute`. We emit heartbeats during long spacing waits so the
 * tool call stays visible and the harness's per-tool timeout resets.
 *
 * Re-exported from the rate-limit module so tool files only import from
 * runner.ts. Matches pi-agent-core's `AgentToolUpdateCallback` shape.
 */
export type ToolProgressCallback = ProgressUpdate;

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
   * If a waitable block (spacing / cooldown) would otherwise fail the call,
   * the limiter is allowed to `sleep` up to this many seconds inside `gate()`
   * before re-checking. Keeps batches draining at the natural pace instead of
   * forcing the agent to orchestrate its own backoff. Budget / working-hours
   * blocks ignore this and still throw immediately.
   */
  waitUpToSec?: number;
  /**
   * Harness-supplied progress callback. When set and the gate has to sleep
   * for a soft block, we emit periodic pings so the harness keeps the tool
   * call live instead of timing it out.
   */
  onUpdate?: ToolProgressCallback;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: null };
}

export function errorResult(
  text: string,
  errorCode: UnipileErrorCode,
  details: unknown = null,
): ToolResult {
  return { content: [{ type: "text", text }], details, isError: true, errorCode };
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
  /**
   * Execute the tool. Signature matches pi-agent-core's AgentTool.execute
   * positionally — we accept an optional AbortSignal (currently unused;
   * reserved for future cancellation plumbing) and an optional progress
   * callback for heartbeats during long spacing waits.
   */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: ToolProgressCallback,
  ) => Promise<ToolResult>;
  /**
   * Per-tool execution mode forwarded to pi-agent-core's AgentTool. Set to
   * "sequential" on write tools so the harness doesn't kick off the gate/jitter
   * for a second write while the first is still in flight — cheap
   * defense-in-depth on top of the limiter's own AsyncMutex, which remains the
   * source of truth across harnesses and concurrent callers.
   */
  executionMode?: "sequential" | "parallel";
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
  const {
    toolName,
    category,
    reservedCost = 1,
    cooldownKey,
    actualCost,
    run,
    waitUpToSec,
    onUpdate,
  } = opts;
  const rule = ctx.limiter.getRule(category);

  const invoke = async (): Promise<ToolResult> => {
    if (!rule.bypassAll) {
      try {
        await ctx.limiter.gate({
          toolName,
          category,
          cost: reservedCost,
          cooldownKey,
          waitUpToSec,
          onUpdate,
        });
      } catch (err) {
        if (err instanceof UnipileLimitError) {
          ctx.log.warn(`${toolName} blocked: ${err.message}`);
          return errorResult(`[unipile:${toolName}] ${err.message}`, err.code);
        }
        throw err;
      }
    }

    const startedAt = Date.now();
    try {
      const result = await run();
      if (!rule.bypassAll) {
        // actualCost is caller-supplied; guard against NaN / -∞ / non-finite
        // values so a buggy extractor can't poison the persisted counters.
        const raw = actualCost ? actualCost(result) : reservedCost;
        const cost = Number.isFinite(raw) ? Math.max(0, raw) : reservedCost;
        ctx.limiter.recordSuccess({
          toolName,
          category,
          cost,
          reservedCost,
          cooldownKey,
          durationMs: Date.now() - startedAt,
        });
      }
      return textResult(
        wrapExternalContent(serialize(result), {
          source: "api",
          sender: `linkedin via unipile (${toolName})`,
        }),
      );
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
          reservedCost,
          cooldownKey,
          durationMs,
          indeterminate: true,
        });
        ctx.log.warn(`${toolName} indeterminate: ${msg}`);
        return errorResult(`[unipile:${toolName}] ${msg}`, "timeout", { indeterminate: true });
      }

      if (!rule.bypassAll) {
        ctx.limiter.recordFailure({
          toolName,
          category,
          reservedCost,
          err,
          cooldownKey,
          durationMs,
        });
      }
      ctx.log.warn(`${toolName} failed: ${msg}`);
      return errorResult(`[unipile:${toolName}] ${msg}`, classifyError(err));
    }
  };

  // Writes serialize globally to avoid concurrent same-account signals to
  // LinkedIn. Reads run in parallel — the daily/weekly/monthly caps still
  // protect the account from volume.
  return rule.serializeCalls ? ctx.limiter.runExclusive(invoke) : invoke();
}
