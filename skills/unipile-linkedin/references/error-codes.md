# LinkedIn error codes

Every error result from a `linkedin_*` tool has an `errorCode`. Branch on it, not on the message text. The five codes that should change immediate flow control are kept in `SKILL.md`; the full set lives here.

| errorCode                              | What to do                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `budget_exhausted`                     | Stop this batch. Use `retryAt` (daily=UTC midnight, weekly/monthly=rolling).                           |
| `working_hours`                        | Stop writes. `retryAt` is the next open window.                                                        |
| `spacing` / `cooldown`                 | Wait until `retryAt`, then retry. (Invitations auto-wait up to 120 s.)                                 |
| `rate_limit`                           | LinkedIn itself rate-limited you. Back off far harder than our caps suggest.                           |
| `account_disconnected` / `checkpoint`  | **Surface to the user.** Agent cannot fix; operator must reconnect via the Unipile dashboard.          |
| `premium_required`                     | Account is missing Sales Navigator / Recruiter / premium. Stop, tell user.                             |
| `account_restricted`                   | LinkedIn has restricted the account. Stop, tell user.                                                  |
| `already_connected`                    | 1st-degree connection exists — skip the invitation; message if needed.                                 |
| `invitation_pending`                   | An invite from us is already pending for this target. Don't retry.                                     |
| `not_connected`                        | Target isn't 1st-degree and the send wasn't an InMail/Open-Profile. Invite first, or route via InMail. |
| `inmail_not_allowed`                   | Target doesn't accept InMails. Connect first.                                                          |
| `insufficient_credits`                 | Out of InMail credits. Stop, tell user.                                                                |
| `blocked_recipient` / `invalid_target` | Skip this target.                                                                                      |
| `content_invalid`                      | Message body is too long or LinkedIn rejected it. Shorten / rephrase.                                  |
| `not_found`                            | Chat / invitation / profile doesn't exist. Re-fetch from a list endpoint.                              |
| `network_error` / `upstream_error`     | Transient. Retry in a few minutes.                                                                     |

## `timeout` — the one that needs care

`errorCode: "timeout"` means **indeterminate**: the write may have landed. Before retrying, verify:

- `linkedin_send_invitation` → check `linkedin_list_invitations_sent`
- `linkedin_send_message` → check `linkedin_list_chat_messages(chatId)`
- `linkedin_start_chat` → scan `linkedin_list_chats` for a recent chat with the attendee `provider_id`s

Cached reads lag ~30–60 s behind LinkedIn; wait before verifying.
