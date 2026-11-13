# Message markers1 — Hub0.7.0

`messenger_message_mark` sets a native reaction by exact account/conversation/message.
MCP and POST /api/v1/call method message_mark use the same input:

```json
{"connectionId":"account-example","conversationId":"123","messageId":"456","status":"in_progress","requestId":"task-example-message456-inprogress-v1"}
```

| Status | Meaning | Telegram | WhatsApp |
|---|---|---|---|
| viewed | Full relevant source inspected | 👀 | 👀 |
| in_progress | Task taken into work | 👨‍💻 | 👨‍💻 |
| completed | Result actually verified | ✅ custom emoji | ✅ |
| question | A question/blocker needs resolution | 🤔 | 🤔 |

Telegram reuses existing bridge custom document5206607081334906820 for the green
check (provider document alt is ✔️; response emoji✅ is the semantic label). Custom emoji permission/availability is provider-controlled; rejection is
failed with a safe reason/providerCode, no silent alternate emoji or bypass.
Only our work emoji change; unrelated own reactions and other participants' reactions
remain untouched. Native expected snapshot CAS detects changes before submission.
WhatsApp has one reaction per account/message: applying a marker replaces that own
reaction, including an earlier non-work reaction. Other users are unaffected.

Exact connection+route read AND send grants required. Marker receipt belongs to
caller scope. Read-only consumers cannot mark by claiming/acking incoming. No new
grants required or enabled. Existing sessions stay in bridges; no LLM/profile needed.
Native topics use parent conversation ID and the exact message ID, not topic title.
GOWA source must exist in its selected route's bounded2000-message history window
before reacting; missing source/group sender never guessed. message_mark unsupported
on other plugins, even if they have send rights. connections.capabilities exposes
messageMarkers (scope-gated) and markerStatuses.

Each transition gets stable requestId. Same request+payload returns durable receipt
without writing again; changed payload -> idempotency_conflict. Receipt fields:
requestId, connectionId, conversationId, messageId, status, state, emoji, phase,
confirmation, nativeReaction/reactions (Telegram), reactionMessageId (WhatsApp).
`applied` is a provider reaction receipt, NOT task completion, message delivery/read,
source acceptance, inbox ack or Markdown write. Old receipt remains proof of the
original action, not current marker after later transitions or manual edits.

Persist intent before network. Concurrent unresolved intents on an exact source are
blocked across scopes; marker_in_flight directs caller to original request. Preflight
failure -> failed, explicit Telegram rejection -> failed, uncertain write -> unknown.
Never retry unknown under a new ID. Use `messenger_message_mark_result`:

```json
{"connectionId":"account-example","requestId":"task-example-message456-inprogress-v1"}
```

This read-only tool reconciles Telegram's current own snapshot; no resend after
restart/crash. An unmatched snapshot leaves unknown. GOWA lacks trusted own-reaction
readback: normal successful API receipt gives confirmation=provider_accepted,
readback=unsupported; lost response remains unknown. Do not mislabel it as failed.
No exactly-once claim for external effects. No automatic arbitrary sequence/blocker
resolution, rollback reaction or user invite. Source task state belongs to caller.

Failures before any write may be retried with a new requestId after fixing the
stated issue; a previous failed receipt stays immutable. Preserve journals on source
rollback. No delete/clear/bulk reaction tools are added.

Synthetic write tests cover request reuse/conflict, competing scopes, restart and
unknown reconciliation, missing source/permissions, native CAS/own reaction preserve,
GOWA exact payload/device/source window. Published schema/source checked separately.
No customer reactions are sent for testing; visual real-message acceptance remains
unverified. Telegram green-check metadata is checked read-only during installation.

Integration prompt: [task-system-marker-prompt.md](task-system-marker-prompt.md).
Primary provider contracts: [Telegram reactions](https://core.telegram.org/api/reactions),
[GOWA9.1 reaction API](https://github.com/aldinokemal/go-whatsapp-web-multidevice/blob/v9.1.0/docs/openapi.yaml).
