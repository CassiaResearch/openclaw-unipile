import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  compact,
  defineTool,
  normalizeOutboundText,
  runUnipileTool,
  type ToolContext,
} from "./runner.js";

const MAX_INVITATION_MESSAGE = 300;

type ReceivedInvitationsResponse = {
  object?: string;
  items?: Array<{
    id?: string;
    specifics?: { provider?: string; shared_secret?: string };
  }>;
  cursor?: string | null;
};

const SendInvitationParams = Type.Object(
  {
    providerId: Type.String({
      description: "Target LinkedIn provider_id (member URN).",
    }),
    message: Type.Optional(
      Type.String({
        maxLength: MAX_INVITATION_MESSAGE,
        description: `Optional connection note (≤${MAX_INVITATION_MESSAGE} chars).`,
      }),
    ),
    waitSec: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 300,
        description:
          "Maximum seconds this call may sleep inside the plugin waiting for the ≥90 s spacing window to clear (default 120). Pass 0 to fail fast with errorCode='spacing' instead — useful if your harness has a short per-tool timeout or if you're orchestrating pacing yourself.",
      }),
    ),
  },
  { additionalProperties: false },
);

const PaginationParams = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const HandleInvitationParams = Type.Object(
  {
    invitationId: Type.String(),
    sharedSecret: Type.String(),
    action: Type.Union([Type.Literal("accept"), Type.Literal("decline")]),
  },
  { additionalProperties: false },
);

const CancelInvitationParams = Type.Object(
  {
    invitationId: Type.String(),
  },
  { additionalProperties: false },
);

export function registerInvitationTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { cfg, client } = ctx;

  api.registerTool(
    defineTool({
      name: "linkedin_send_invitation",
      label: "LinkedIn: send connection invitation",
      description:
        "Send a LinkedIn connection request. `providerId` is the target's provider_id (member URN) — get it from linkedin_search result items, linkedin_get_profile, or linkedin_list_relations. Optional `message` is capped at 300 characters. Blocked outside working hours; writes are serialized and spaced ≥90 s apart with daily/weekly/monthly caps. By default the call waits up to 120 s for the spacing window and emits progress heartbeats every ~10 s (`details.status=\"waiting\"`, `secondsRemaining`, `readyAt`) so harnesses keep the tool call alive; override via `waitSec` if you prefer fail-fast. Returns `{ object: 'UserInvitationSent', invitation_id }`.",
      parameters: SendInvitationParams,
      execute: async (_id, params, _signal, onUpdate) => {
        // 300-char cap is enforced by the JSON schema (`maxLength`), so input
        // that exceeds it is rejected before execute() runs.
        const providerId = params.providerId.trim();
        const message = params.message ? normalizeOutboundText(params.message) : "";
        return runUnipileTool(ctx, {
          toolName: "linkedin_send_invitation",
          category: "invitation_write",
          // Default 120 s covers the 90 s spacing plus slack; agent can lower
          // (even to 0) to match its own orchestration / timeout budget.
          waitUpToSec: params.waitSec ?? 120,
          // Forward the harness's progress callback so the limiter can emit
          // heartbeats during the spacing wait — keeps the tool call visible
          // instead of going dark for up to 120 s.
          onUpdate,
          run: () =>
            client.users.sendInvitation(
              compact({
                account_id: cfg.accountId,
                provider_id: providerId,
                message: message || undefined,
              }),
            ),
        });
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_list_invitations_sent",
      label: "LinkedIn: list sent invitations",
      description:
        "List connection requests you've sent that are still pending. Pass `limit` OR `cursor`, not both. Returns `{ items: [{ id, ...target }, ...], cursor }`. Subject to a 4 h polling cooldown.",
      parameters: PaginationParams,
      execute: async (_id, params) =>
        runUnipileTool(ctx, {
          toolName: "linkedin_list_invitations_sent",
          category: "relation_poll",
          cooldownKey: "linkedin_list_invitations_sent",
          run: () =>
            client.users.getAllInvitationsSent(
              compact({
                account_id: cfg.accountId,
                limit: params.limit,
                cursor: params.cursor,
              }),
            ),
        }),
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_list_invitations_received",
      label: "LinkedIn: list received invitations",
      description:
        "List pending connection requests from other users. Returns `{ items: [{ id, specifics: { shared_secret }, ... }, ...], cursor }` — `id` + `specifics.shared_secret` from the same item are both required by linkedin_handle_invitation. Subject to a 4 h polling cooldown.",
      parameters: PaginationParams,
      execute: async (_id, params) => {
        const query: Record<string, string> = { account_id: cfg.accountId };
        if (params.limit !== undefined) query.limit = String(params.limit);
        if (params.cursor) query.cursor = params.cursor;
        return runUnipileTool(ctx, {
          toolName: "linkedin_list_invitations_received",
          category: "relation_poll",
          cooldownKey: "linkedin_list_invitations_received",
          run: () =>
            client.request.send<ReceivedInvitationsResponse>({
              method: "GET",
              path: ["users", "invite", "received"],
              parameters: query,
            }),
        });
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_handle_invitation",
      label: "LinkedIn: accept or decline a received invitation",
      description:
        "Accept or decline a pending received invitation. Pass both `invitationId` (items[].id) and `sharedSecret` (items[].specifics.shared_secret) from the same linkedin_list_invitations_received item. Blocked outside working hours.",
      parameters: HandleInvitationParams,
      execute: async (_id, params) =>
        runUnipileTool(ctx, {
          toolName: "linkedin_handle_invitation",
          category: "invitation_write",
          run: () =>
            client.request.send<unknown>({
              method: "POST",
              path: ["users", "invite", "received", params.invitationId.trim()],
              body: {
                provider: "LINKEDIN",
                account_id: cfg.accountId,
                shared_secret: params.sharedSecret.trim(),
                action: params.action,
              },
            }),
        }),
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_cancel_invitation_sent",
      label: "LinkedIn: withdraw a sent invitation",
      description:
        "Withdraw a previously-sent connection request before it's accepted. invitationId comes from linkedin_list_invitations_sent.",
      parameters: CancelInvitationParams,
      execute: async (_id, params) =>
        runUnipileTool(ctx, {
          toolName: "linkedin_cancel_invitation_sent",
          category: "default",
          run: () =>
            client.users.cancelInvitationSent({
              account_id: cfg.accountId,
              invitation_id: params.invitationId,
            }),
        }),
    }),
  );
}
