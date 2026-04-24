---
name: unipile-linkedin
description: LinkedIn automation via Unipile — search, connect, profiles, message, invitation workflows with hard-enforced daily/weekly/monthly caps and human-like pacing. Use when the user wants to find LinkedIn prospects, invite connections, reply to DMs, triage pending invitations, or manage outreach on the connected account.
metadata:
  { "openclaw": { "emoji": "💼" } }
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

Use this skill for any LinkedIn outreach, messaging, or inbox work on the connected Unipile account. Not for: email outreach, billing/account reconnection, or managing multiple LinkedIn accounts.

All `linkedin_*` tools operate on **one** connected LinkedIn account — the `accountId` from plugin config. The account is either **classic**, **sales_navigator**, or **recruiter**; the plugin picks sensible defaults per tier.

If writes globally fail with `account_disconnected` or `checkpoint`, the account needs a human — surface that to the user and stop. For any block you don't understand, call `linkedin_usage_report` (free, bypasses rate limiting) to see working-hours state, per-category budgets, cooldowns, and recent gate decisions.

## Safety Rails (Do Not Fight Them)

- **Writes are capped** per-day, per-week, and per-month. Hitting a cap returns `isError: true` with `errorCode: "budget_exhausted"`. Don't retry — wait.
- **Writes are spaced** (invitations ≥90 s apart). `linkedin_send_invitation` waits up to 120 s for the spacing window by default and emits a progress heartbeat every ~10 s while waiting (`details.status = "waiting"`, `secondsRemaining`, `readyAt`). Most harnesses treat these as liveness pings and keep the tool call alive. If your harness doesn't, pass `waitSec: 0` (or a smaller value) to fail fast with `errorCode: "spacing"` + a `retryAt` timestamp and orchestrate pacing yourself.
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

Every error result has an `errorCode`. Branch on it, not on the message text. The codes that should change immediate flow control:

| errorCode                             | What to do                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget_exhausted`                    | Stop this batch. Use `retryAt` (daily=UTC midnight, weekly/monthly=rolling).                                                                             |
| `working_hours`                       | Stop writes. `retryAt` is the next open window.                                                                                                          |
| `spacing` / `cooldown`                | Wait until `retryAt`, then retry. (Invitations auto-wait up to 120 s.)                                                                                   |
| `timeout`                             | **Indeterminate — the write may have landed.** Verify via the matching list endpoint before any retry. Cached reads lag ~30–60 s; wait before verifying. |
| `account_disconnected` / `checkpoint` | **Surface to the user.** Agent cannot fix; operator must reconnect via the Unipile dashboard.                                                            |

Full code reference (premium / credit / target-state / content / network codes): see `references/error-codes.md`.

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

> ⚠️ **One recipient per call.** Passing multiple `attendeeProviderIds` creates ONE **group chat** with all of them, not individual DMs. For outreach to N people, call N times with one id each.

Defaults to Sales Navigator API on SN/Recruiter accounts. For InMail, pass `inmail: true` — the plugin will force the classic path regardless of searchType (InMail only exists on classic messaging).

If there **is** an existing chat (look it up via `linkedin_list_chats`):

```
linkedin_send_message (chatId, text)
```

## Patterns to Avoid

- **Polling faster than the cooldown.** `linkedin_list_relations`, `linkedin_list_invitations_*` each carry a 4 h per-tool cooldown. If a call returns `errorCode: "cooldown"`, wait until `retryAt` — don't pound the tool.
- **Ignoring `pending_invitation` on search results.** Re-inviting a pending target returns `errorCode: "invitation_pending"`.
- **Retrying a timeout.** See the `timeout` row in Error Handling — verify via the matching list endpoint before retrying.
- **Bulk outreach with identical bodies.** LinkedIn flags repeated identical message text as automation. Vary the opener, even minimally.
- **Fighting working hours.** Don't retry write calls outside the window — they'll keep failing. Schedule batches inside it, or use `retryAt` to know when to resume.

## Diagnostic Workflow

`linkedin_usage_report` surfaces:

- `workingHours.ok` + `nextOkAt`
- per-category `today/week/month` used vs. remaining + `spacingReadyAt`
- `cooldowns` with `readyAt` per polling tool
- `recentEvents` with the last N gate decisions
