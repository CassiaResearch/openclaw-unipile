---
name: unipile-linkedin
description: LinkedIn automation via Unipile — search, connect, message, invitation workflows with hard-enforced daily/weekly/monthly caps and human-like pacing. Use when the user wants to find LinkedIn prospects, invite connections, reply to DMs, triage pending invitations, or manage outreach on the connected account.
metadata:
  { "openclaw": { "emoji": "💼", "requires": { "config": ["dsn", "apiKey", "accountId"] } } }
allowed-tools:
  [
    "linkedin_search",
    "linkedin_search_parameters",
    "linkedin_get_profile",
    "linkedin_get_own_profile",
    "linkedin_get_company",
    "linkedin_send_invitation",
    "linkedin_list_invitations_sent",
    "linkedin_list_invitations_received",
    "linkedin_handle_invitation",
    "linkedin_cancel_invitation_sent",
    "linkedin_list_relations",
    "linkedin_list_chats",
    "linkedin_list_chat_messages",
    "linkedin_list_messages_from_attendee",
    "linkedin_send_message",
    "linkedin_start_chat",
    "linkedin_usage_report",
    "linkedin_check_budget",
  ]
---

# Unipile LinkedIn

All `linkedin_*` tools operate on **one** connected LinkedIn account — the `accountId` from plugin config. The account is either **classic**, **sales_navigator**, or **recruiter**; the plugin picks sensible defaults per tier.

## Safety Rails (Do Not Fight Them)

- **Writes are capped** per-day, per-week, and per-month. Hitting a cap returns `isError: true` with `errorCode: "budget_exhausted"`. Don't retry — wait.
- **Writes are spaced** (invitations ≥90 s apart). `linkedin_send_invitation` waits up to 120 s for the spacing window by default. If your harness has a short per-tool timeout, pass `waitSec: 0` (or a smaller value) to fail fast with `errorCode: "spacing"` + a `retryAt` timestamp and orchestrate pacing yourself.
- **Writes are blocked outside working hours.** Reads run any time. If a write returns `errorCode: "working_hours"`, the block is unconditional until `retryAt`.
- **Writes serialize** on a per-account mutex. Firing many invites in parallel is fine — they queue, not race.

## Identifiers Reference

Three IDs appear in responses. They are NOT interchangeable.

| ID                                | What it is                         | Where it comes from                                                  | What it's for                                                             |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `provider_id`                     | LinkedIn member URN                | search results, `linkedin_get_profile`, `linkedin_list_relations`    | `linkedin_send_invitation`, `linkedin_start_chat`, `linkedin_get_profile` |
| `public_identifier`               | LinkedIn slug (e.g. `"elonmusk"`)  | search results, profile                                              | `linkedin_get_profile` only                                               |
| `attendee_id` / `sender_id`       | Unipile chat-scoped id             | `linkedin_list_chats` items, `linkedin_list_chat_messages` sender_id | `linkedin_list_messages_from_attendee` only                               |
| `chat_id`                         | Unipile chat id                    | `linkedin_list_chats` items, `linkedin_start_chat` response          | `linkedin_list_chat_messages`, `linkedin_send_message`                    |
| `invitation_id` + `shared_secret` | Pair from one received-invite item | `linkedin_list_invitations_received` items                           | `linkedin_handle_invitation` (pass both)                                  |

Passing `sender_id` to `linkedin_send_invitation` will fail with `errorCode: "invalid_target"`. Use `provider_id`.

## Error Handling

Every error result has an `errorCode`. Branch on it, not on the message text.

| errorCode                              | What to do                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget_exhausted`                     | Stop this batch. Use `retryAt` (daily=UTC midnight, weekly/monthly=rolling).                                                                                                                                                                                                                                                                               |
| `working_hours`                        | Stop writes. `retryAt` is the next open window.                                                                                                                                                                                                                                                                                                            |
| `spacing` / `cooldown`                 | Wait until `retryAt`, then retry. (Invitations auto-wait up to 120 s.)                                                                                                                                                                                                                                                                                     |
| `rate_limit`                           | LinkedIn itself rate-limited you. Back off far harder than our caps suggest.                                                                                                                                                                                                                                                                               |
| `account_disconnected` / `checkpoint`  | **Surface to the user.** Agent cannot fix; operator must reconnect via the Unipile dashboard.                                                                                                                                                                                                                                                              |
| `premium_required`                     | Account is missing Sales Navigator / Recruiter / premium. Stop, tell user.                                                                                                                                                                                                                                                                                 |
| `account_restricted`                   | LinkedIn has restricted the account. Stop, tell user.                                                                                                                                                                                                                                                                                                      |
| `already_connected`                    | 1st-degree connection exists — skip the invitation; message if needed.                                                                                                                                                                                                                                                                                     |
| `invitation_pending`                   | An invite from us is already pending for this target. Don't retry.                                                                                                                                                                                                                                                                                         |
| `not_connected`                        | Target isn't 1st-degree and the send wasn't an InMail/Open-Profile. Invite first, or route via InMail.                                                                                                                                                                                                                                                     |
| `inmail_not_allowed`                   | Target doesn't accept InMails. Connect first.                                                                                                                                                                                                                                                                                                              |
| `insufficient_credits`                 | Out of InMail credits. Stop, tell user.                                                                                                                                                                                                                                                                                                                    |
| `blocked_recipient` / `invalid_target` | Skip this target.                                                                                                                                                                                                                                                                                                                                          |
| `content_invalid`                      | Message body is too long or LinkedIn rejected it. Shorten / rephrase.                                                                                                                                                                                                                                                                                      |
| `not_found`                            | Chat / invitation / profile doesn't exist. Re-fetch from a list endpoint.                                                                                                                                                                                                                                                                                  |
| `timeout`                              | **The write may have landed.** For `linkedin_send_invitation`: check `linkedin_list_invitations_sent` before retrying. For `linkedin_send_message`: check `linkedin_list_chat_messages(chatId)`. For `linkedin_start_chat`: scan `linkedin_list_chats` for a recent chat with the attendee provider_ids. Cached reads lag ~30–60 s; wait before verifying. |
| `network_error` / `upstream_error`     | Transient. Retry in a few minutes.                                                                                                                                                                                                                                                                                                                         |

## Pre-flight Planning

Before a large batch (say, 20+ invitations), call `linkedin_check_budget` with `{ category: "invitation_write", cost: <N> }`. Response:

```json
{
  "ok": false,
  "blockingReason": "Daily invitation write budget exhausted: ...",
  "blockingCode": "budget_exhausted",
  "retryAt": "2026-04-23T00:00:00.000Z",
  "remaining": { "today": 2, "week": 45, "month": 200 }
}
```

Use `remaining.today` to right-size the batch. `ok: false` with `blockingCode: "spacing"` is expected mid-batch and fine; the next invitation call will auto-wait.

## Canonical Flows

### 1. Prospect → Invite

```
linkedin_search_parameters  (resolve "San Francisco" → location ID, if using filters)
linkedin_search             (compact: true for large result sets)
→ for each item with network_distance != DISTANCE_1 and !pending_invitation:
  linkedin_send_invitation  (provider_id from item, optional 300-char note)
```

Notes:

- Use `compact: true` on searches unless you need full position/education history.
- Don't invite `network_distance: "DISTANCE_1"` — they're already connected.
- Skip items where `pending_invitation: true`.
- Open-profile users (`open_profile: true`) can be InMailed without connecting.

### 2. Inbox Triage

```
linkedin_list_chats (unread: true)
→ for each chat:
  linkedin_list_chat_messages (chat_id from item.id)
  linkedin_send_message (chat_id, text)
```

Chat listing and message history are cached by Unipile and don't charge budget.

### 3. Accept / Decline Received Invitations

```
linkedin_list_invitations_received
→ for each items[]:
  linkedin_handle_invitation (invitationId = item.id, sharedSecret = item.specifics.shared_secret, action)
```

Both `invitationId` and `sharedSecret` come from the same item. Blocked outside working hours.

### 4. Withdraw Stale Sent Invitations

```
linkedin_list_invitations_sent
→ for items older than N days:
  linkedin_cancel_invitation_sent (invitationId = item.id)
```

### 5. Follow-up Messaging (New Conversation)

If there's **no existing chat** with the target:

```
linkedin_start_chat (attendeeProviderIds: [oneId], text)
```

Passing multiple `attendeeProviderIds` creates ONE group chat with all of them — for individual outreach to N people, call N times, one recipient each. Defaults to Sales Navigator API on SN/Recruiter accounts. For InMail, pass `inmail: true` — the plugin will force the classic path regardless of searchType (InMail only exists on classic messaging).

If there **is** an existing chat (look it up via `linkedin_list_chats`):

```
linkedin_send_message (chatId, text)
```

## Patterns to Avoid

- **Polling faster than the cooldown.** `linkedin_list_relations`, `linkedin_list_invitations_*` each carry a 4 h per-tool cooldown. If a call returns `errorCode: "cooldown"`, wait until `retryAt` — don't pound the tool.
- **Ignoring `pending_invitation` on search results.** Re-inviting a pending target returns `errorCode: "invitation_pending"`.
- **Retrying a timeout.** `errorCode: "timeout"` means indeterminate — the write may have landed. Verify via `linkedin_list_invitations_sent` / `linkedin_list_chats` before any retry. Remember those reads are cached and can lag ~30–60 s behind LinkedIn; wait before verifying.
- **Bulk outreach with identical bodies.** LinkedIn flags repeated identical message text as automation. Vary the opener, even minimally.
- **Fighting working hours.** Don't retry write calls outside the window — they'll keep failing. Schedule batches inside it, or use `retryAt` to know when to resume.

## Diagnostic Workflow

When a tool returns an unexpected block, call `linkedin_usage_report` (free, bypasses rate limiting) to see:

- `workingHours.ok` + `nextOkAt`
- per-category `today/week/month` used vs. remaining + `spacingReadyAt`
- `cooldowns` with `readyAt` per polling tool
- `recentEvents` with the last N gate decisions

If writes are globally failing with `errorCode: "account_disconnected"` or `"checkpoint"`: the account needs a human. Surface that to the user.
