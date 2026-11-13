# Telegram native mention evidence1 — Hub0.6.2 / HUB022

Published `schema.mentionEvidenceSchema`, `mentionEvidenceVersion:1`; additive
normalized message field. Native entities are obtained only from the existing
Telegram bridge-owned client; no auth/login/session copies or contact model.

```json
{"mentionEvidence":{"version":1,"source":"telegram_native_entities","complete":true,"textField":"text","coordinateSystem":"utf16","entities":[{"nativeType":"MessageEntityMentionName","offset":3,"length":5,"recipientUserId":"100000001","username":null}]}}
```

Synthetic source text: `🙂 Owner` (emoji occupies2 UTF16 code units).
`MessageEntityMentionName`: exact recipientUserId; username null. Offset/length
must be integer, positive length, within full message.text UTF16 units, at scalar
boundaries. Human label/name is not identity. `MessageEntityMention`: recipientUserId
null, username derived ONLY from exact native entity slice `@username`.
Case-insensitive username comparison is allowed only against current verified
self.username. Never use plain substring, replyTo, chat title or another recipient.

```json
{"connectionId":"account-example","self":{"id":"100000001","isSelf":true,"username":"owner_example","verified":true,"evidence":"telegram_get_me","verifiedAt":"2026-10-02T10:00:00Z"}}
```

`messenger_identity({connectionId})` / HTTP call method identity reads get_me on
existing session. Expected configured self ID is checked; mismatch blocks identity.
Account username may be null; then username mentions stay held. verifiedAt is UTC
observation time, not indefinite identity authority; Clerk controls refresh/age policy.
Optional root account labels current bridge client, not a caller-controlled session.

## Complete/closed semantics

- Native Message.entities None is a complete empty list: no native mentions.
- Missing native entity attribute, unsupported mention type, malformed/bounds/
  surrogate boundary/recipient -> complete:false plus safe errorCode.
- Absent legacy cached evidence -> unknown; full completeness never inferred from text.
- max100 mention entities; overlimit incomplete. Full source retained separately.
- Compact clipping sets complete:false/errorCode:text_truncated even if a mention
  lies inside the excerpt. Full event_get/message_get required before group filter.
- Other formatting entities may be omitted from this mention-only DTO, without
  making supported mention coverage incomplete. entity list is not full formatting AST.
- Bridge/helper retains native original text. Enrichment/presentation cannot infer
  new mentions. Names and richMessage content remain untrusted data.

Clerk group policy: accept only complete evidence and exact native owner mention.
Completeness/DTO1 does not itself authorise a task: source provenance, authorship,
project relevance and owner policy are independent gates. All messages retained,
including no-mention/group held history. Hub does not turn every chat into tasks.

## Selected raw reads and native collector

Operator `settings.nativeHistoryConversations` exact route list selects raw native
history/message RPCs; other chats retain legacy behaviour. Native cursors nh:<nativeID>
are separate from old page cursors. Exact full topic reads use existing root RPC.
Each page reads native messages/entities/sender metadata together; no per-message
get_sender/contact lookup/model. Default cached tools never contact provider.

Existing bridge registers NewMessage/Edit/Delete on explicit chatIds; native outbox
commits full body/entities/capture proof before local HTTP. Exact Hub binding/scoped
subscriber grants before cache/journal, separate private ingest token; reader key
cannot ingest/send. No all-account native subscription, no global Codex changes.
History recovery worker may remain disabled when native is selected; initial backfill
has bounded pages/continuation, gap/window status explicit. No implied gap-free stream.

`connections.sourceCapabilities.ingestion`: configured/mode, lastReceiptAt,
producerCapturedAt/providerEventId, commitLatencyMs, sourceTimestampAgeMs (clock-dependent).
Native callback event.ingestion.observation carries captureAt/providerEventId; receivedAt
is Hub commit observation. Clerk adds its local committedAt in own replica.
These fields allow provider callback→Hub→Clerk timing correlation after a real event.
No event observed -> telegram_native_awaiting_receipt, no measured speed claim.
health.nativeCollector enabled/registeredHandlers/selectedChatCount/pendingOutbox/
forwardedReceipts proves hook installation ONLY, not actual delivery latency.

## Channel readonly vs local queue management

Dedicated reader scope has read:true/send:false, no assistant/profile/admin/nativeIngest.
Inbox.read/manage/push operate only its exact allowed conversations. Local
subscription_save/consumer_ensure/claim/ack writes durable reader state, not client messages.
Identifiers are arbitrary valid local IDs, not extra grants; derived IDs are permitted
without creating/assigning someone else's consumers. Existing warm subscriptions and
acks untouched. A different conversation or connection fails before provider I/O.
SSE/read APIs localhost bearer, exact scope. No credentials/tokens in examples.

Private live owner request controls chosen routes and actual credential paths; no real
chat bodies/peer labels/keys in fixtures or Git. Unconfirmed extra endpoint excluded.
Workzone/GOWA target/MTS auth remain unchanged; Palatine sole ASR. This stage's warm
subscriptions explicitly autoAudio:false; no archive media downloads/ASR triggered.
Future explicit authorised media reads/transcribe use normal Palatine contract.

## Synthetic and public acceptance

UTF16 astral/named/wrong recipient/bounds/username/native empty/missing/malformed/
compact truncation; selected-vs-legacy bridge reads; read-only derived IDs isolation;
late poll cannot overwrite native receipt diagnostic. Existing restart/dedup/lease/ASR
scenarios preserved. Live entities support/identity/selected cached replay/native hooks
verified read-only. Actual natural incoming proof, if absent, remains outstanding.
