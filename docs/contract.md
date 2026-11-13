> ASR policy updated in Hub0.6.3 / HUB-026: in-Hub recognition now uses the
> explicitly configured Codex LB purpose, no fallback. Ready historical transcripts
> retain their original source; MTS MCP retains upstream transcription ownership.
> See [current ASR contract](codexlb-asr.md); earlier Palatine-only notes are historical.

# Communication contract v1

MCP tools: messenger_connections, health, conversations, history, attachment,
profile, events, send, delivery (all prefixed messenger_). Structured JSON results.
Schemas live in src/contracts.mjs; src/mcp.mjs exposes input schemas. `send` is
not listed for credentials without write grants. Every call rechecks grants.

Plugin exports id, contractVersion=1, create(settings). Instance declares
capabilities (history/send/attachments/changes, supported kinds, maxText) and
implements conversations, history; optional health, send, attachment, close.
No WorkZone-specific database IDs or tasks cross this boundary.

History pages are newest-first, with provider-owned opaque next cursor and an
explicit complete flag. Numeric providers additionally declare order=numeric for crossing a deleted cursor boundary. IDs are strings and scoped by connection+conversation.
Only explicit deletedAt is a tombstone. A missing row/page is never deletion.
Call kind preserves a call/record composite ID, source audio and transcript;
speaker labels are estimates, not verified identities. Text must not be truncated
silently. Original provider history/archive remains canonical.

Journal records IDs+content hashes when history is observed. It is not a provider
push subscription. Each consumer stores its own event cursor; reads do not consume
events. WorkZone owns polling of selected subscriptions and continuity checks.
Provider webhook/MCP waits remain usable as wakeup optimizations; periodic reads
recover gaps. No account-wide background history collection is implied by installing.

Send: requestId binds exact connection/conversation/text/reply. The durable unknown
record is committed before network I/O. A retry returns the stored receipt; changed
payload fails. Unknown does not permit automatic re-send. delivery reads the same
ledger and returns tracked=false when the request predates it; it cannot invent proof of non-delivery from an absent history row. Ledger
is local metadata and must be backed up when moving the service.

With the optional contact assistant, imported Hub-owned Markdown profiles take precedence;
legacy profiles remain a fallback. See `contact-agent.md` for the new tools and grants.
Profiles remain private Markdown. Exact identity selects a configured file
or Telegram numeric filename. No name-based merging, no default generation, no
profile changes in a send call. Agents must read profile and fresh history before
composing. Skills are separately installed instructions; MCP connectivity alone
does not guarantee an agent will follow a skill.

MTS provides only recording IDs/audio/metadata. Hub recognizes speech via Palatine,
including calls; archive/MTS ASR is never a fallback. Optional speaker labels/time
offsets come from Palatine with explicit uncertainty. No source transcript is
silently truncated. A provider without send capability remains read-only.

WorkZone aliases telegram-main and whatsapp-main to its existing native channel
identities during migration. New plugin connections use namespaced hub identities.
Existing unknown deliveries absent from the hub ledger stay unknown; use the retained
legacy reconciliation path or manual evidence review, never a new automatic send.

A connection may configure profileIdentityField for exact identities in a Markdown
frontmatter list (for WhatsApp: whatsapp_jids). New profiles written in the existing
skill's multiline-list format become readable without service reconfiguration.
Only that field matches; incidental mentions, names, and outside symlinks do not.
Ambiguous duplicate profiles fail closed. Existing explicit mappings still work.

## Media and read extensions (HUB-003)

The additive optional attachment fields are fileId/downloadUrl/transcription and
providerVersion; message sourceText preserves the provider caption when text gains a
labeled audio transcript. mediaMetadataIncomplete explicitly flags missing metadata.
Original provider IDs and the v1 raw send/attachment contracts remain unchanged.

Optional plugin methods: contacts({query,cursor,limit}), search({conversationId,query,
cursor,limit}) -> normal conversation/history pages; attachmentInfo -> metadata;
attachmentFile -> validated local path/size/mimeType/filename. Legacy plugins retain
history-scan search and capped base64 attachment fallback. Each method still belongs
to its configured connection, never accepts an arbitrary account or executable.

History may enqueue bounded ASR. Wait returns burst summaries, keeps independent
scoped cursor snapshots, and does not consume upstream global Telegram events.
See `media-search-wait.md` for the complete tools and state contract.

## Owner-only forum provisioning (HUB-017)

Additive MCP/API methods group_ensure and group_result use connection+external
client key identity and separate, default-off grants. Creation stages are durable
and recover through the existing Telegram bridge. No title-based identity, new
session, arbitrary invitations, message grants or WorkZone agent execution.
See [Telegram forum group contract](telegram-forum-groups.md) for complete schemas,
policy, errors, reconciliation and rollout/rollback instructions.

## HUB-018: durable subscriptions/inbox (0.4.0)
Шесть additive операций: subscription_save/status, inbox_consumer_ensure/claim/ack/event_get.
Wire2/plugin1 сохраняются. Отдельные scope inbox.read/manage + текущий exact route read;
send не выдаётся. HTTP worker default off; page checkpoint и consumer ack независимы.
Lease/replay, immutable edits/media supplements, Palatine-only subscription ASR,
ограничения provider polling и rollback: [durable-inbox.md](durable-inbox.md).

## HUB-019: clerk read/push contracts (0.5.0)
Четыре additive MCP tools: inbox_projects/replay/context/diagnostics, wire2/plugin1.
Local scoped GET /inbox/events (SSE, durable Last-Event-ID) и POST /inbox/read
(read allowlist) не создают turns и не двигают consumer ack. Collector/push/new grants
default-off. Bounded snapshot continuation, confirmed mappings и question/App Server
boundary: [clerk-api.md](clerk-api.md). Current in-Hub ASR is Codex LB (HUB-026); MTS owns upstream transcripts;
legacy cache preserved privately for rollback, never a recognition fallback.

## Read/HTTP contract 1 (Hub0.6.0)

Default cached reads, explicit refresh, exact topics, native default-off ingestion
и scoped local HTTP composer/read описаны в [Rust Clerk API](rust-clerk-api.md).
Wire contract2/plugin1 сохранены, schema публикует actual scope capabilities.

## Addendum HUB021 /0.6.1

[Inbox provenance1 / immutable cutover / author labels](inbox-provenance.md).
from_now retains all journal events; historical filtering belongs to Clerk. Legacy
missing evidence is unknown/review, late media inherits source affiliation.

## Addendum HUB022 /0.6.2

[Native Telegram mentionEvidence1 / verified identity / scoped reader setup](telegram-mentions.md).
New identity MCP/HTTP method, health HTTP allowlist. Exact private selected activation
can enable native/SSE without all-account polling or send; no natural receipt means no latency claim.

## HUB-030 / markerContractVersion1
MCP message_mark/message_mark_result and local API share [message-markers.md](message-markers.md). Telegram/WhatsApp only; exact send grants, no unknown retries.

## Optional reply policy1 (Hub0.8.2)
Exact scoped lookup is separate from style-history/transport100-message windows.
Unavailable/deleted quote => omit quote, same conversation/topic and text/media;
returned additive replyFallback:{status:omitted,requestedReplyTo,effectiveReplyTo:null,
reason:reply_target_unavailable|reply_target_deleted|reply_target_rejected|topic_quote_unsupported}.
No needs_review/error solely for omission. Cached targets avoid provider discovery.
Exact source/account mismatch and revoked grants still reject. Telegram arbitrary
forum quotes are omitted while the verified topic anchor is retained by its adapter.
Effective quote is durable before the write; delivery reconciles that quote while
idempotency retains original payload hash. A proven quote-only Telegram RPC
no-create rejection allows at most one unquoted attempt. Arbitrary errors or
lost replies never authorize another write. Legacy pinned local quote guards
are classified failed/not_created on receipt reads, without automatically resending.
No read receipt or task completion is implied by provider_sent.

## Download contract1 — Hub0.8.3
file_download input:{fileId:UUID,waitMs?:integer0..25000(default25000)}.
Existing ready fields are unchanged, additive status:ready and optional download
lifecycle. Long reads return status:downloading,path:null,sha256:null,
download:{status:running,startedAt},retryAfterMs:1000,nextAction. Repeat same UUID;
no new request ID, source, credentials or ASR action. Every read rechecks grants.
Existing files_download supports the same single total page wait budget, with
per-file ready/downloading/failed. Durably stored lifecycle is running/ready/
failed/interrupted; restart reports interruption without bulk provider requests.
A future explicit read safely retries an interrupted/failed read. In-memory
same-UUID transfer coalesces concurrent calls; journal records no false byte
progress. Original path/size/hash appear only after bounded validated copy.
Telegram settings.downloadTimeoutMs defaults600000, bounded1000..1800000;
only original-media read gets this budget. Underlying provider session unchanged.

### Video preparation recovery — Hub0.8.4
A legacy failed original download cannot permanently poison video_prepare once
that exact original is verified cached. Next explicit prepare resumes only when
failure was before durable core entry/SHA, with a recognized download failure.
Frozen settings remain unchanged, previous error is retained as recovery metadata.
video_status exposes canResume:true and error.stage:download/retryable:true;
this status read itself starts no ASR. A coreStarted marker is persisted before
headless paid processing. Paid failed/submission_unknown states never reopen via
this path; the shared core independently checks existing paid receipts/OS locks.

## Telegram history normalization — Hub0.8.5
Unknown/deleted author metadata is allowed: senderId:null,isSelf:null, with no
invented label. Do not infer owner/recipient from message body tokens. Provider
record IDs remain unchanged; unknown-author rows are never silently dropped.
Malformed input returns telegram_history_shape with safe adapter/operation/field/
expected/actualType/recordIndex, not raw row text. Native account scope unchanged.
History optional transcribeAudio:false prevents new automatic ASR/download work
for that history request; existing cached transcripts remain readable. Default
behavior is unchanged. Repeat this optional flag exactly with next cursor;
adding it to an existing cursor changes its options digest, so start a fresh
history chain if the original request did not contain it.
