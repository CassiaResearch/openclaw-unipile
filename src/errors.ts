import type { RateCategory } from "./types.js";

export class UnipileLimitError extends Error {
  readonly kind = "limit" as const;
  constructor(message: string) {
    super(message);
    this.name = "UnipileLimitError";
  }
}

/**
 * Known Unipile error type slugs, harvested from ~90d of production telemetry
 * of an earlier system (see UNIPILE_ERROR_INSIGHTS.md). The list is **not
 * closed** — Unipile adds new types without notice. Unknown slugs still flow
 * through via the `(string & {})` escape hatch on `ErrorInfo.type`.
 */
export type UnipileErrorType =
  // 400
  | "errors/malformed_request"
  | "errors/missing_parameters"
  | "errors/too_many_characters"
  // 401 (auth)
  | "errors/unauthorized"
  | "errors/missing_credentials"
  | "errors/multiple_sessions"
  | "errors/invalid_checkpoint_solution"
  | "errors/checkpoint_error"
  | "errors/invalid_credentials"
  | "errors/expired_credentials"
  | "errors/insufficient_privileges"
  | "errors/disconnected_account"
  | "errors/disconnected_feature"
  | "errors/invalid_credentials_but_valid_account_imap"
  | "errors/expired_link"
  | "errors/wrong_account"
  // 403
  | "errors/account_restricted"
  | "errors/insufficient_permissions"
  | "errors/session_mismatch"
  | "errors/feature_not_subscribed"
  | "errors/resource_access_restricted"
  // 404
  | "errors/resource_not_found"
  | "errors/invalid_resource_identifier"
  // 422
  | "errors/invalid_account"
  | "errors/invalid_recipient"
  | "errors/no_connection_with_recipient"
  | "errors/blocked_recipient"
  | "errors/unprocessable_entity"
  | "errors/invalid_message"
  | "errors/invalid_post"
  | "errors/not_allowed_inmail"
  | "errors/insufficient_credits"
  | "errors/cannot_resend_yet"
  | "errors/cannot_invite_attendee"
  | "errors/invalid_reply_subject"
  | "errors/invalid_headers"
  | "errors/limit_too_high"
  | "errors/limit_exceeded"
  | "errors/user_unreachable"
  | "errors/already_connected"
  // 429
  | "errors/too_many_requests"
  // 5xx
  | "errors/provider_error"
  | "errors/unexpected_error"
  | "errors/proxy_error"
  | "errors/network_down"
  | "errors/request_timeout";

export interface ErrorInfo {
  status: number | undefined;
  // Typed union gives autocomplete on known slugs but still accepts unknown
  // strings when Unipile ships a new one. See `(string & {})` TS idiom.
  type: UnipileErrorType | (string & {}) | undefined;
  bodyText: string;
}

/**
 * Narrow a thrown value (typically Unipile's `UnsuccessfulRequestError`) down
 * to the fields we actually care about — HTTP status, error type slug, and a
 * serialized body for logging.
 */
export function inspectError(err: unknown): ErrorInfo {
  if (!err || typeof err !== "object") {
    return { status: undefined, type: undefined, bodyText: "" };
  }
  const e = err as {
    status?: number;
    statusCode?: number;
    code?: string | number;
    body?: unknown;
    response?: { status?: number; data?: unknown };
  };
  const rawBody = e.body ?? e.response?.data;
  const bodyObj =
    rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
      ? (rawBody as Record<string, unknown>)
      : undefined;

  const status =
    (bodyObj && typeof bodyObj.status === "number" ? bodyObj.status : undefined) ??
    (typeof e.status === "number" ? e.status : undefined) ??
    (typeof e.statusCode === "number" ? e.statusCode : undefined) ??
    (typeof e.response?.status === "number" ? e.response.status : undefined) ??
    (typeof e.code === "number" ? e.code : undefined);

  const type = bodyObj && typeof bodyObj.type === "string" ? bodyObj.type : undefined;

  let bodyText = "";
  if (typeof rawBody === "string") {
    bodyText = rawBody;
  } else if (bodyObj) {
    try {
      bodyText = JSON.stringify(bodyObj);
    } catch {
      bodyText = "";
    }
  }

  return { status, type, bodyText };
}

// --- Groupings ---
// Grouped because LinkedIn/Unipile bounces between these depending on the
// exact failure mode but the user-visible remediation is the same. Typed as
// Set<string> so .has(type) works without casts; the Set<UnipileErrorType>
// constructor call validates each literal at compile time.
const LOGGED_OUT_TYPES: ReadonlySet<string> = new Set<UnipileErrorType>([
  "errors/disconnected_account",
  "errors/expired_credentials",
  "errors/invalid_credentials",
  "errors/invalid_credentials_but_valid_account_imap",
  "errors/wrong_account",
]);

const PREMIUM_MISSING_TYPES: ReadonlySet<string> = new Set<UnipileErrorType>([
  "errors/feature_not_subscribed",
  "errors/invalid_headers",
  "errors/invalid_account",
  "errors/insufficient_privileges",
  "errors/multiple_sessions",
  "errors/missing_credentials",
  "errors/unauthorized",
]);

const CHECKPOINT_TYPES: ReadonlySet<string> = new Set<UnipileErrorType>([
  "errors/checkpoint_error",
  "errors/invalid_checkpoint_solution",
]);

const RATE_PENALTY_TYPES: ReadonlySet<string> = new Set<UnipileErrorType>([
  "errors/too_many_requests",
  "errors/limit_exceeded",
  "errors/provider_error",
]);

/**
 * A timed-out write to Unipile may still have landed on LinkedIn. Signaling
 * this as outright failure would lead the agent to retry and double-send
 * invitations or messages. Treat it as indeterminate: counted against budget
 * (the write probably happened), but the agent is told to verify before
 * retrying.
 */
export function isIndeterminateSend(err: unknown, category: RateCategory): boolean {
  if (category !== "invitation_write" && category !== "message_write") return false;
  const { type, status } = inspectError(err);
  return type === "errors/request_timeout" || status === 504;
}

/**
 * Does this error warrant the rate-limit penalty (inflates bucket usage to
 * slow future calls)?
 */
export function isRatePenalty(err: unknown): boolean {
  const { status, type } = inspectError(err);
  if (status === 429 || status === 500 || status === 502 || status === 503) return true;
  return !!type && RATE_PENALTY_TYPES.has(type);
}

export function toToolError(err: unknown, toolName: string): string {
  if (err instanceof UnipileLimitError) return err.message;

  const { status, type, bodyText } = inspectError(err);
  const msg = err instanceof Error ? err.message : String(err);
  const detail = bodyText && !msg.includes(bodyText) ? ` — ${bodyText}` : "";
  const typeSuffix = type ? ` ${type}` : "";

  // --- Auth / account lifecycle ---
  if (type && LOGGED_OUT_TYPES.has(type)) {
    return `Your LinkedIn account is logged out of Unipile (${type}). Reconnect it via the Unipile dashboard before retrying ${toolName}.`;
  }
  if (type && PREMIUM_MISSING_TYPES.has(type)) {
    return `${toolName} failed because the connected LinkedIn account is missing the required access (${type}). Usually means Sales Navigator / Recruiter / premium is required, revoked, or the session is degraded.${detail}`;
  }
  if (type && CHECKPOINT_TYPES.has(type)) {
    return `LinkedIn is requesting verification (captcha / 2FA). Resolve the checkpoint via the Unipile dashboard, then retry ${toolName}.`;
  }
  if (type === "errors/account_restricted") {
    return `Connected LinkedIn account has been restricted by LinkedIn. Manual action in the LinkedIn UI is required before ${toolName} will work again.`;
  }
  if (type === "errors/session_mismatch") {
    return `Unipile session mismatch on ${toolName}. Reconnect the account via the Unipile dashboard.`;
  }

  // --- Invitation-specific ---
  if (type === "errors/cannot_resend_yet") {
    return `LinkedIn invitation cooldown: a pending invitation already exists for this target. Wait for it to be accepted, or withdraw it via linkedin_cancel_invitation_sent before retrying.`;
  }
  if (type === "errors/already_connected") {
    return `You're already connected to this LinkedIn user — no invitation needed. Use linkedin_start_chat or linkedin_send_message to reach them.`;
  }
  if (type === "errors/cannot_invite_attendee") {
    return `LinkedIn refused this invitation target for ${toolName}. The profile may be restricted from receiving invites from the connected account.`;
  }

  // --- Messaging-specific ---
  if (type === "errors/blocked_recipient") {
    return `Recipient is not reachable — account appears deactivated or messaging is blocked. (${toolName})`;
  }
  if (type === "errors/no_connection_with_recipient") {
    return `Not connected to this recipient. Send an invitation first via linkedin_send_invitation, or use an Open-Profile / paid InMail.`;
  }
  if (type === "errors/resource_access_restricted") {
    return `Recipient has restricted who can message them. (${toolName})`;
  }
  if (type === "errors/not_allowed_inmail") {
    return `Target does not accept InMails from the connected account. Try an Open-Profile InMail, or invite them to connect first.`;
  }
  if (type === "errors/insufficient_credits") {
    return `Out of InMail credits on the connected LinkedIn account.`;
  }
  if (type === "errors/invalid_message") {
    return `LinkedIn rejected the message for ${toolName} (content or length issue). Check for banned text, attachments, or exceeded character limits.`;
  }
  if (type === "errors/invalid_recipient") {
    // Intentionally generic: the same slug means different things depending on
    // endpoint (blocked-by-user for sendMessage, inaccessible-profile for
    // invite / lookup). Don't lie about which one.
    return `LinkedIn cannot reach this recipient for ${toolName}. Depending on the call path this can mean the profile is blocked, locked down, or unreachable by the connected account.`;
  }

  // --- Common misc ---
  if (type === "errors/too_many_characters") {
    return `Input exceeds LinkedIn's character limit for ${toolName}.${detail}`;
  }
  if (type === "errors/resource_not_found" || status === 404) {
    return `LinkedIn / Unipile returned 404 for ${toolName}: the referenced resource (chat, profile, invitation) no longer exists or hasn't been indexed yet.${detail}`;
  }
  if (type === "errors/invalid_resource_identifier") {
    return `Malformed ID passed to ${toolName}.${detail}`;
  }
  if (type === "errors/user_unreachable") {
    return `Target LinkedIn user is currently unreachable. (${toolName})`;
  }

  // --- Rate / infra ---
  if (type === "errors/too_many_requests" || status === 429) {
    return `LinkedIn rate limit hit (${type ?? "429"}) on ${toolName}. Back off and retry later.${detail}`;
  }
  if (type === "errors/limit_exceeded") {
    return `LinkedIn account limit exceeded (usually daily/weekly quota) on ${toolName}. Back off and retry tomorrow.${detail}`;
  }
  if (type === "errors/provider_error" || status === 500 || status === 502 || status === 503) {
    return `Upstream Unipile/LinkedIn error (${type ?? status}) on ${toolName}. Often caused by LinkedIn throttling — back off and retry later.${detail}`;
  }
  if (type === "errors/network_down" || type === "errors/proxy_error") {
    return `Network / proxy issue between Unipile and LinkedIn on ${toolName}. Retry in a few minutes.${detail}`;
  }
  if (type === "errors/request_timeout" || status === 504) {
    return `Unipile request timed out for ${toolName}. The call may or may not have landed on LinkedIn — check linkedin_list_chats or linkedin_list_invitations_sent before retrying, otherwise you risk a double-send.`;
  }

  // --- HTTP-status fallbacks for unknown types with recognizable status ---
  if (status === 401) {
    return `Unipile: unauthorized (401). Check the apiKey config.${detail}`;
  }
  if (status === 403) {
    return `Unipile: forbidden (403${typeSuffix}). The connected LinkedIn account may lack the required plan/permission for ${toolName}.${detail}`;
  }
  if (status === 400) {
    return `Unipile: bad request (400${typeSuffix}) for ${toolName}.${detail}`;
  }
  if (status === 422) {
    return `Unipile: unprocessable (422${typeSuffix}) for ${toolName}.${detail}`;
  }

  return `${toolName} failed${type ? ` (${type})` : ""}: ${msg}${detail}`;
}
