# Unipile LinkedIn plugin for OpenClaw

Wraps the [`unipile-node-sdk`](https://www.npmjs.com/package/unipile-node-sdk) to give the agent LinkedIn reach — messaging, connections, profile lookup, and Sales Navigator search — against a single, already-connected LinkedIn account.

**Defaults to Sales Navigator** for search and profile reads. Enforces daily, weekly, and monthly quotas per LinkedIn account, minimum call spacing, working-hours windows, per-tool polling cooldowns, and jitter. All outbound Unipile calls are serialized through an async mutex so no two actions can fire concurrently.

## Install

```bash
openclaw plugins install copilotai-unipile \
  --marketplace https://github.com/CassiaResearch/openclaw-marketplace
```

## Configure

Either set env vars on the gateway process:

```
UNIPILE_DSN=https://apiXX.unipile.com:443XX
UNIPILE_API_KEY=...
UNIPILE_ACCOUNT_ID=...
```

or put the values in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "copilotai-unipile": {
      "enabled": true,
      "dsn": "https://apiXX.unipile.com:443XX",
      "apiKey": "...",
      "accountId": "...",
      "accountTier": "sales_navigator"
    }
  }
}
```

All three credentials are required. Without them the plugin logs a warning and disables itself — it doesn't crash the gateway.

## Tools

| Tool                                   | Category         | Notes                                                                                                                  |
| -------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `linkedin_get_own_profile`             | default          | —                                                                                                                      |
| `linkedin_get_profile`                 | profile_read     | Sales Nav API by default                                                                                               |
| `linkedin_get_company`                 | profile_read     | —                                                                                                                      |
| `linkedin_search`                      | search_results   | Sales Nav API by default; accepts a browser URL or keywords/filters/category; cost = results returned                  |
| `linkedin_search_parameters`           | default          | Resolves LOCATION/INDUSTRY/COMPANY/SKILL/SCHOOL/LANGUAGE/SERVICE names → LinkedIn IDs for use in `filters`             |
| `linkedin_list_chats`                  | cached_read      | Unipile-cached, bypasses all guardrails                                                                                |
| `linkedin_list_chat_messages`          | cached_read      | Unipile-cached, bypasses all guardrails                                                                                |
| `linkedin_list_messages_from_attendee` | cached_read      | All messages with one attendee across every thread; Unipile-cached                                                     |
| `linkedin_send_message`                | message_write    | Working-hours gated                                                                                                    |
| `linkedin_start_chat`                  | message_write    | Working-hours gated                                                                                                    |
| `linkedin_send_invitation`             | invitation_write | Working-hours gated, ≥90 s spacing, ≤300-char message                                                                  |
| `linkedin_list_invitations_sent`       | relation_poll    | 4 h cooldown (per-tool)                                                                                                |
| `linkedin_list_invitations_received`   | relation_poll    | 4 h cooldown (per-tool)                                                                                                |
| `linkedin_handle_invitation`           | invitation_write | Working-hours gated                                                                                                    |
| `linkedin_cancel_invitation_sent`      | default          | —                                                                                                                      |
| `linkedin_list_relations`              | relation_poll    | 4 h cooldown (per-tool)                                                                                                |
| `linkedin_usage_report`                | cached_read      | Returns current per-category usage, remaining budgets, cooldowns, and working-hours status. Read-only, no budget cost. |

`accountId` is never a tool parameter — the plugin injects the configured one on every call.

## Guardrails

All guardrails are hard blocks: the tool returns a readable error and does not hit Unipile.

### Daily / weekly / monthly quotas (per LinkedIn account)

| Category               |                          Day | Week |  Month | Notes                                                                                                                                   |
| ---------------------- | ---------------------------: | ---: | -----: | --------------------------------------------------------------------------------------------------------------------------------------- |
| Invitations            |                           80 |  200 |    600 | Paid-account defaults. LinkedIn caps ~200/week at the protocol level. For free accounts with a note, set `invitationsPerMonth: 5`.      |
| Profile reads          | 100 (×2 Sales Nav/Recruiter) |    — |  3 000 | —                                                                                                                                       |
| Search results fetched |    2 500 (1 000 for classic) |    — | 50 000 | Cost = number of results returned, not number of calls.                                                                                 |
| Messages / InMails     |                          100 |    — |  2 000 | For InMails (`linkedin_start_chat` with `inmail=true`), lower `messagesPerMonth` to ~800 to match LinkedIn's free-InMail monthly quota. |
| Other                  |                          100 |    — |  2 000 | Default bucket for everything else.                                                                                                     |

Windows are rolling, not calendar-based.

### Pacing

Per-category behavior — not everything has the same guardrails:

| Category                                                     | Mutex (serialize)                                                             | Jitter | Gate (budget / working hours / cooldown)                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| `invitation_write`, `message_write`                          | **yes** — writes share one mutex; no two writes ever in flight simultaneously | yes    | yes                                                                   |
| `profile_read`, `search_results`, `relation_poll`, `default` | no — concurrent reads allowed                                                 | yes    | yes                                                                   |
| `cached_read` (chat/message reads)                           | no                                                                            | no     | no — Unipile serves these from its own cache; they never hit LinkedIn |

Details:

- **Jitter**: 400–1500 ms random delay before every outbound call that hits LinkedIn.
- **Minimum spacing**: ≥90 s between consecutive invitations.
- **Polling cooldown**: 4 h between calls to _each_ `relation_poll` tool (tracked per tool, not per category). Calling `list_relations` does not reset the cooldown on `list_invitations_received`.
- **Working hours**: writes (invitations, messages) blocked outside 09:00–18:00 in your configured timezone, and outside the configured working days (default Mon–Fri). Reads are always allowed.
- **429 / 500 handling**: counted as 5× cost against the bucket and forces a longer pause.

The mutex is writes-only by design: LinkedIn's automation detection fingerprints concurrent writes from a single account, but concurrent reads are fine (and the daily/weekly/monthly caps already limit read volume).

Counters persist at `~/.openclaw/unipile/<accountId>/usage.json`. Shape:

- `aggregates.daily[date][category] = { calls, penalty }` — real calls vs. 429/500 penalty inflation, split so you can tell them apart.
- `aggregates.perTool[date][toolName] = count` — per-tool breakdown for the day.
- `lastCallAt[category]`, `lastCooldownAt[cooldownKey]` — ISO 8601, readable without the plugin.
- `events[]` — ring buffer of the most recent usage events (default 500, configurable via `telemetry.eventRingSize`). Each is `{ t, tool, cat, cost, result, durationMs?, errorStatus?, reason? }`. Most-recent-first.
- Top-level `createdAt`, `updatedAt`, `accountId`, `accountTier` for diagnostics.

History is retained indefinitely (no pruning). Writes are debounced (~1 s coalesce) and flushed on gateway shutdown via `registerService`. Corrupt / unreadable files are logged and the counter starts fresh; the daily limits still apply within the session. Schema is versioned (`version: 1`) for future migrations.

The plugin is designed for a single-gateway deployment. Two gateways pointed at the same `accountId` would race on the file and lose increments.

Everything above is configurable via `limits`, `pacing`, and `workingHours` in plugin config.

## Error handling

Errors returned by Unipile are mapped to agent-readable messages based on their `errors/*` type slug — see `src/errors.ts` for the full `UnipileErrorType` union. Common cases the agent will encounter:

- **Logged-out account** (`errors/disconnected_account`, `errors/expired_credentials`, etc.) → "Reconnect via the Unipile dashboard."
- **Premium / Sales Nav missing** (`errors/feature_not_subscribed`, `errors/invalid_headers`, etc.) → "Connected account lacks the required LinkedIn seat."
- **Checkpoint / verification** (`errors/checkpoint_error`) → "Resolve via the Unipile dashboard."
- **Already connected** (`errors/already_connected`) → "Use linkedin_send_message instead."
- **Invite cooldown** (`errors/cannot_resend_yet`) → "Pending invite exists; wait or withdraw."
- **Blocked / unreachable recipient** (`errors/blocked_recipient`, `errors/resource_access_restricted`, etc.) → specific reason surfaced.
- **Out of InMail credits** (`errors/insufficient_credits`) → explicit message.
- **Rate limits** (`errors/too_many_requests`, `errors/limit_exceeded`, `errors/provider_error`) → budget penalty applied + back-off guidance. 502/503 are treated the same as 500.

### Outbound text normalization

All outbound free-text fields — message bodies, invite notes, `start_chat` subjects — are normalized before leaving the plugin:

- `\r\n` and bare `\r` collapsed to `\n`.
- Leading/trailing whitespace trimmed.

Rationale: LinkedIn stores what you send byte-for-byte. Mixed line endings between what your system has on record and what Unipile returns on subsequent reads silently break equality checks — a real bug observed in production at a sibling system. Normalizing outbound keeps stored == sent == what Unipile returns.

Inbound messages from Unipile are **not** modified; they come through exactly as Unipile returns them. If your workflow layer compares message bodies byte-for-byte, normalize on its side too.

Note: `start_chat`'s `subject` parameter is only rendered when sending as InMail (`searchType: "classic"` + `inmail: true`). LinkedIn silently drops it for direct messages.

### Duplicate-message protection

`linkedin_send_message` and `linkedin_start_chat` refuse to send the exact same text to the same chat (or same set of attendees) twice. LinkedIn's automation detection flags identical repeated bodies, so this is a hard rail — the tool returns a readable error and does not hit Unipile.

- `send_message` keys on `chatId`.
- `start_chat` keys on the sorted attendee provider IDs joined with `|` — so the same template sent to different recipients individually is fine; the same text sent to the same group twice is blocked.
- Text normalization: trim + lowercase + whitespace collapse. Trivial variations (extra newlines, capitalization) still count as duplicates.
- Up to 100 recent hashes per key are kept in `usage.json`. No time expiration.
- Indeterminate timeouts also record the hash — if the send might have landed, retrying the same text is blocked to avoid double-sends.

Known gap: after `start_chat` succeeds, a follow-up `send_message` on the resulting chatId with the same text is **not** blocked (different key namespace). If your workflow chains the two, handle idempotency at the workflow layer.

### Indeterminate sends

For write operations (`linkedin_send_invitation`, `linkedin_send_message`, `linkedin_start_chat`, `linkedin_handle_invitation`), a Unipile timeout (`errors/request_timeout` or HTTP 504) does **not** fail the tool — the write may have succeeded on LinkedIn and retrying blindly would double-send. Instead the tool:

- Counts the call against the daily/weekly/monthly budget (conservative).
- Records a `result: "indeterminate"` event in `usage.json` for observability.
- Returns a text response telling the agent to verify via `linkedin_list_chats` or `linkedin_list_invitations_sent` before any retry.

Context-dependent mapping (e.g. `errors/invalid_recipient` meaning different things for send-message vs send-invite vs profile-lookup) is deliberately left to the workflow layer — the plugin's text keeps the Unipile type slug visible so downstream consumers can make their own interpretations.

## A note on tool output

`linkedin_list_invitations_received` includes `items[].specifics.shared_secret` in its response — the agent needs it to call `linkedin_handle_invitation`. If your pipeline logs or persists tool outputs (e.g. LangSmith traces), those secrets will be visible there. Ensure upstream redaction if that matters.

## References

- [Unipile developer docs](https://developer.unipile.com/)
- [Node SDK on GitHub](https://github.com/unipile/unipile-node-sdk)
- [Provider limits & restrictions](https://developer.unipile.com/docs/provider-limits-and-restrictions)
- [Detecting accepted invitations (webhook — future work)](https://developer.unipile.com/docs/detecting-accepted-invitations)
