# Public MCP v2 acceptance and operation

The compatible wire version remains `version: 1` for WorkZone. Runtime metadata now
reports `serverVersion: 0.2.2`, additive `contractVersion: 2`, and unchanged plugin
contract 1. `health` (with optional connectionId) and `connections.server` expose
`buildId`, `startedAt`, `schemaHash`, and `sourceMatchesRunningBuild`. `schema` returns
current tool input schemas. Its hash covers `{name,inputSchema,description}` in tool
order. The acceptance test compares these with actual `listTools`, not source files.

- Current server schema contains `format`, client catalog does not: refresh/restart
  the client session. An old server version/build/schema requires a service restart.
- `sourceMatchesRunningBuild=false`: disk files changed after this process loaded.
  Prompts are now loaded with code, preventing new prompts from reaching old parsers.
- The STDIO proxy advertises the connected Hub version. HTTP `/health` also returns
  process/build metadata without private configuration or tokens.

## Identity and search

`contact_resolve` accepts `self` / `Избранное`, a contact ID, a phone number, or an
explicit `connectionId` + `conversationId`. It never sends or calls the LLM, but can
register a provider-verified new endpoint. Self comes from the authorized Telegram
account identity; title substrings such as “Твоё избранное” are not self. Multiple
accounts require an explicit route. Telegram contacts/conversations also resolve
exact self aliases directly.

An explicit endpoint outranks ambiguous display names. A supplied contact ID that
contradicts that endpoint is rejected. `contact_search` accepts an exact endpoint;
`endpoint_already_linked` includes the accessible existing contactId. Profile/source
scope checks still apply. Phone numbers match address-book endpoints as well as names.

Provider contacts and chat indexes cover different data. `contacts.coverage` and
`conversations.coverage` name the source and pagination completeness; conversations
suggest contacts as an alternative. Address-book discovery uses provider contacts.
Do not interpret a single page with no matches as an exhaustive account search.

## Errors and preparation retry

Public diagnostic fields: `code`, `stage`, `description`, `correlationId`, `retryable`,
`nextAction`; schema errors additionally return field paths/codes without input values.
Raw exceptions, tokens, provider bodies and profiles are never error messages.

A failed preparation explicitly reports that no send occurred. Correct its cause,
then repeat the **original unchanged** payload/requestId with `retryPreparation=true`. Changed parameters require a **new requestId**. Unsupported formats are rejected before history/profile/LLM at `format_validation`, with `allowedFormats`, `retryable:false` and `canRetryPreparation:false`; choose an allowed format/auto and a new ID. This
flag is excluded from the payload hash. It only retries `failed` preparation; it
cannot reset preparing/sending/unknown or change an already reviewed text. Successful
previews keep text and format frozen. Legacy opaque failures cannot recover their
lost exception, but expose safe retry guidance. Historical failure cause remains
unproven; a mixed old-process/new-prompt contract was a plausible prior mechanism.

## Submission receipts

`sent` / `confirmation=provider_sent` confirms provider submission, not delivery to
or reading by the recipient. `recipientDelivery` and `recipientRead` remain unknown.
WhatsApp persists attempt time, prior message IDs and any returned candidate ID.
Reconciliation reads only: exact route, outgoing direction, exact text/reply and
candidate ID, or one unique new match in a bounded attempt time window. Duplicates,
missing history and failed reads remain unknown. History scan is bounded to 1000
messages; use provider evidence/manual inspection when it cannot reach an old attempt.
Legacy smart operations can use their persisted preparedAt; raw legacy attempts
without correlation evidence remain uncertain. Never replay under a new requestId.

## Read presentation and files

History keeps legacy full output by default. Use `mode=compact`, `maxTextChars`,
`maxTranscriptChars`, and `maxTotalChars` (compact default 16000 text characters).
Compact mode puts transcripts only in attachments, not again in message text.
`textTruncated`/`textLength` identify shortened fields. `attachmentTypes` filters the
current provider page; preserve its cursor and coverage. `message_get` returns the
full message/transcript (native exact lookup on Telegram; bounded 2000-message
fallback elsewhere). Native rich blocks/partial flag are available in Telegram
message_get. History is a readable projection, not lossless markup.

MCP result data exists once in structuredContent; content is a short summary.
`files_download` accepts up to 20 fileIds and returns per-file status/hash/size/MIME,
transcript status/length, or diagnostics; it does not repeat full transcripts.
`file_download` still returns the complete transcript next to the downloaded file.
Common image/audio/PDF signatures determine MIME after download, including cached
files formerly labeled octet-stream. Unknown binary formats remain octet-stream.

Media errors distinguish `attachment_not_found` (404), `attachment_gone` (410),
explicit `attachment_expired`, decryption, permission and temporary failures.
404/410 alone do not identify the historical retention/deletion cause. Legacy ASR
failures gain safe diagnostics; rechecking original downloads can refine them.
ASR exposes lifecycle transitions, so queued → running → ready remains observable
when work finishes between polls. Cached transcripts are not regenerated implicitly.

## Local media sends

Capabilities separate `downloadAttachments` from `sendAttachments`; `attachments`
is the legacy download flag. `mediaTypes` lists supported outbound kinds. Writable
connections expose an isolated `uploadRoot` for this credential scope. Copy only the
intended file there, then use `media_stage` (no send) or `send_media` with localPath.
Alternatively send a staged/downloaded fileId belonging to that exact route.

`send_media`: route, requestId, one of localPath/fileId, type, optional caption and
replyTo. Types: image, document, voice, audio, video. Maximum 25 MiB; local voice
requires actual OGG/Opus, local video currently requires an MP4 signature. Explicit
staging produces an immutable cached copy with SHA256. Changed bytes under the same
requestId conflict. Arbitrary local paths and cross-scope uploads are rejected.

Telegram uses the existing bridge's new `send_media_with_receipt` tool. Its additive
patch is in `bridges/telegram-media-receipt.patch`; existing sessions/roots checks
remain untouched. WhatsApp uses local multipart REST on the same GOWA bridge,
with its fixed device ID; no public URL or auth-state copy is required. WhatsApp
voice/audio do not support captions: send as a document when a caption is needed.
See the [pinned GOWA 9.1 schema](https://raw.githubusercontent.com/aldinokemal/go-whatsapp-web-multidevice/v9.1.0/docs/openapi.yaml).

`media_delivery` verifies a prior media ID through history without uploading again.
A lost response with no correlated ID remains unknown; no resend is inferred.
Native media sends were tested with fake transports and the bridge extension in
isolation; no real recipient received a media test. Visual/live send acceptance is
still an owner scenario, not established by mocks.

## Verification and rollback

`scripts/smoke-public-mcp.mjs CREDENTIAL PRIVATE_FIXTURE` uses only public MCP,
normal client credentials and a locally generated synthetic voice. It never calls
send tools. It checks real published schemas, identity, prior receipt, rich preview,
media errors/downloads, compact history and a fresh CodexLB transcription digest.
The new synthetic ASR ran queued → running → ready and returned text plus OGG file;
this is not a newly received Telegram/WhatsApp voice from a real sender.

Backup pointer: `~/.config/messenger-hub/hub-006-deploy.json`. Restore source archive
and, if reverting the bridge extension, its saved `telegram-media-before.py`, then
restart both services. Preserve current contact/media/delivery databases and additive
tables. Never restore an old journal over newly sent or reconciled messages. Review
current files before rollback; do not overwrite unrelated Telegram bridge changes.

## 0.2.1 retest corrections

`maxTotalChars` is explicitly a text/transcript budget, retained for compatibility.
`maxResponseChars` limits `JSON.stringify(MCP_call_result).length`, including both
`content` and `structuredContent` (not transport JSON-RPC/SSE framing). Compact defaults
to 16000 characters; explicit budgets range from 1000 to 1000000. Follow opaque `next`
with identical route, limit, filters and presentation settings. Snapshots persist in
the scoped read database for 24 hours; expired/mismatched cursors fail explicitly.
Filtered provider pages can be empty with a non-null next. Provider offsets never skip
unreturned items. A single oversized record yields `detailsOmitted`, message ID,
attachmentCount and a truncated excerpt; `messenger_message_get` retains full data.
Repeated URLs/routes/ASR transitions are omitted in compact mode. The public retest
read all 100 original IDs in 74 pages with no duplicates and a maximum MCP result
length of exactly 1000 characters.

Media submission confirmation is separate from quote validation. `replyVerification`
is `confirmed`, `mismatch`, `unavailable`, or `not_requested`. Missing historical quote
evidence never turns a proven send into unknown and never authorizes another upload.
The four retest unknown operations were reconciled through public MCP against their
existing correlated IDs, without invoking a send tool. Telegram voice failure came
from the bridge's `[empty]` placeholder for an empty caption, not a missing message ID.

GOWA 9.1 constructs native quote ContextInfo for media but discarded it in persistent
history and the history API. `bridges/gowa-9.1.0-reply-evidence.patch` targets tag v9.1.0,
commit edf4351b4ffec8dfc78d443b1409759fcfc9e75d, and builds as v9.1.0-hub.1. It adds nullable
`reply_message_id` via migration 44, captures native stanza IDs in incoming/sent/history
paths, and exposes them in REST/MCP history. Legacy NULL is deliberately not backfilled
from the Hub's intended payload. `replyToKnown=false` distinguishes unknown history from
an observed message with no reply. Set the trusted connection setting `replyEvidence:true`
only after deploying this patch; it advertises `mediaReplyReadback` in capabilities.
New native media reply persistence has unit coverage, but no new real client send was
performed by this verification. The three old WA quote links remain unconfirmed.

Telegram staging now uses a unique directory plus the original basename. New uploads
retain their display name; existing remote uploads with UUID-prefixed filenames are
not retroactively renamed. PhotoSizeProgressive cumulative sizes are counted; the
photo in the retest is 3130 bytes with `sizeVariant:largest`/`downloadVariant:largest`.
Downloaded/cached MIME determines the local extension; `originalFilename` preserves
provider metadata. Existing PNG bytes named .jpg now produce a .png path/name with the
same SHA-256. Cached voice transcription remains ready and is not regenerated.

## 0.2.2 search and complex HTML

WhatsApp text search uses Unicode/NFC matching of bounded history pages in the
selected authorized chat, not GOWA native SQLite search. SQLite LOWER folds ASCII,
while GOWA lowercases the Unicode query; GOWA native SearchMessages also ignores
offset. Each Hub call examines at most 500 rows, returns at most limit matches, and
continues at the first unexamined row. Sparse windows can have no items, next non-null
and complete=false. Cursors bind chat/query; coverage is
provider_history_unicode_search_plus_observed_audio. No account-wide/background scan.

## Group provisioning (Hub0.3.0)

`messenger_group_ensure` and `messenger_group_result` are additive and independently
scoped. Ensure is hidden unless the administrator enables this exact connection
and grants groups.ensure; result may remain available with groups.read after writes
are disabled. [Full input/result/API contract](telegram-forum-groups.md).

## HUB-018: durable subscriptions/inbox (0.4.0)
Шесть additive операций: subscription_save/status, inbox_consumer_ensure/claim/ack/event_get.
Wire2/plugin1 сохраняются. Отдельные scope inbox.read/manage + текущий exact route read;
send не выдаётся. HTTP worker default off; page checkpoint и consumer ack независимы.
Lease/replay, immutable edits/media supplements, Palatine-only subscription ASR,
ограничения provider polling и rollback: [durable-inbox.md](durable-inbox.md).
