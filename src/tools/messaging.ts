import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  compact,
  defineTool,
  normalizeOutboundText,
  runUnipileTool,
  type ToolContext,
} from "./runner.js";

const ChatSearchType = Type.Union(
  [Type.Literal("sales_navigator"), Type.Literal("classic"), Type.Literal("recruiter")],
  { description: "Messaging API variant. Defaults to sales_navigator when available." },
);

const ListChatsParams = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 250 })),
    cursor: Type.Optional(Type.String()),
    unread: Type.Optional(Type.Boolean()),
    before: Type.Optional(Type.String({ description: "ISO datetime upper bound." })),
    after: Type.Optional(Type.String({ description: "ISO datetime lower bound." })),
  },
  { additionalProperties: false },
);

const ListChatMessagesParams = Type.Object(
  {
    chatId: Type.String(),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 250 })),
    cursor: Type.Optional(Type.String()),
    before: Type.Optional(Type.String()),
    after: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ListMessagesFromAttendeeParams = Type.Object(
  {
    attendeeId: Type.String(),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 250 })),
    cursor: Type.Optional(Type.String()),
    before: Type.Optional(Type.String({ description: "ISO datetime upper bound." })),
    after: Type.Optional(Type.String({ description: "ISO datetime lower bound." })),
  },
  { additionalProperties: false },
);

const SendMessageParams = Type.Object(
  {
    chatId: Type.String(),
    text: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const StartChatParams = Type.Object(
  {
    attendeeProviderIds: Type.Array(Type.String(), {
      minItems: 1,
      description: "One or more recipient provider_ids (LinkedIn member IDs).",
    }),
    text: Type.String({ minLength: 1 }),
    subject: Type.Optional(Type.String()),
    searchType: Type.Optional(ChatSearchType),
    inmail: Type.Optional(
      Type.Boolean({
        description: "Only valid with searchType=classic — send as InMail (uses InMail credits).",
      }),
    ),
  },
  { additionalProperties: false },
);

export function registerMessagingTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { cfg, client } = ctx;
  const salesLike = cfg.accountTier === "sales_navigator" || cfg.accountTier === "recruiter";

  api.registerTool(
    defineTool({
      name: "linkedin_list_chats",
      label: "LinkedIn: list chats",
      description:
        "List LinkedIn DM conversations for the connected account. Supports pagination and filtering by unread. Served from Unipile's cache; bypasses the rate limiter.",
      parameters: ListChatsParams,
      execute: async (_id, params) =>
        runUnipileTool(ctx, {
          toolName: "linkedin_list_chats",
          category: "cached_read",
          run: () =>
            client.messaging.getAllChats(
              compact({
                account_id: cfg.accountId,
                limit: params.limit,
                cursor: params.cursor,
                unread: params.unread,
                before: params.before,
                after: params.after,
              }),
            ),
        }),
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_list_chat_messages",
      label: "LinkedIn: list messages in a chat",
      description:
        "Fetch the message history of a LinkedIn DM thread. Requires chatId from linkedin_list_chats. Served from Unipile's cache; bypasses the rate limiter.",
      parameters: ListChatMessagesParams,
      execute: async (_id, params) =>
        runUnipileTool(ctx, {
          toolName: "linkedin_list_chat_messages",
          category: "cached_read",
          run: () =>
            client.messaging.getAllMessagesFromChat(
              compact({
                chat_id: params.chatId,
                limit: params.limit,
                cursor: params.cursor,
                before: params.before,
                after: params.after,
              }),
            ),
        }),
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_list_messages_from_attendee",
      label: "LinkedIn: list all messages exchanged with an attendee",
      description:
        "Return the full message history with a single LinkedIn attendee across every chat thread (1-to-1 and group). 'attendeeId' is the Unipile attendee_id, which appears on chat objects returned by linkedin_list_chats and as sender_id on messages returned by linkedin_list_chat_messages — it is NOT a LinkedIn provider_id or member URN. Served from Unipile's cache; bypasses the rate limiter.",
      parameters: ListMessagesFromAttendeeParams,
      execute: async (_id, params) =>
        runUnipileTool(ctx, {
          toolName: "linkedin_list_messages_from_attendee",
          category: "cached_read",
          run: () =>
            client.messaging.getAllMessagesFromAttendee(
              compact({
                attendee_id: params.attendeeId,
                limit: params.limit,
                cursor: params.cursor,
                before: params.before,
                after: params.after,
              }),
            ),
        }),
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_send_message",
      label: "LinkedIn: reply in a chat",
      description:
        "Send a text message in an existing LinkedIn DM thread. Blocked outside working hours. Use linkedin_start_chat to initiate a new conversation.",
      parameters: SendMessageParams,
      execute: async (_id, params) => {
        const text = normalizeOutboundText(params.text);
        return runUnipileTool(ctx, {
          toolName: "linkedin_send_message",
          category: "message_write",
          dedup: { key: `msg:${params.chatId}`, payload: text },
          run: () => client.messaging.sendMessage({ chat_id: params.chatId, text }),
        });
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "linkedin_start_chat",
      label: "LinkedIn: start a new chat",
      description:
        "Start a new LinkedIn DM. Provide one or more attendee provider_ids (LinkedIn member IDs) and the opening message. Defaults to the Sales Navigator messaging API when available. Blocked outside working hours. Note: `subject` is only rendered when sending as InMail (searchType='classic' + inmail=true); LinkedIn silently drops it for direct messages.",
      parameters: StartChatParams,
      execute: async (_id, params) => {
        const effectiveType = params.searchType ?? (salesLike ? "sales_navigator" : "classic");
        const text = normalizeOutboundText(params.text);
        const subject = params.subject ? normalizeOutboundText(params.subject) : undefined;
        const base = compact({
          account_id: cfg.accountId,
          text,
          attendees_ids: params.attendeeProviderIds,
          subject,
        });

        // Sorted + joined so "same group + same text" gets blocked regardless
        // of attendee order. Different recipients started individually get
        // different keys — bulk template outreach is fine.
        const dedupKey = `chat:${[...params.attendeeProviderIds].sort().join("|")}`;

        return runUnipileTool(ctx, {
          toolName: "linkedin_start_chat",
          category: "message_write",
          dedup: { key: dedupKey, payload: text },
          run: () => {
            if (effectiveType === "sales_navigator") {
              return client.messaging.startNewChat({
                ...base,
                options: { linkedin: { api: "sales_navigator" } },
              });
            }
            if (effectiveType === "recruiter") {
              return client.messaging.startNewChat({
                ...base,
                options: { linkedin: { api: "recruiter" } },
              });
            }
            return client.messaging.startNewChat({
              ...base,
              options: {
                linkedin: compact({ api: "classic" as const, inmail: params.inmail }),
              },
            });
          },
        });
      },
    }),
  );
}
