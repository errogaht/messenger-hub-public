# ASR contract2 — Hub0.6.3

Owner-authorised provider replacement for recognition performed **inside Hub**.
MTS MCP still owns its transcripts/recovery, no duplicate upload by Hub.

```json
{"media":{"asrProvider":"codexlb","codexlb":{"keyFile":"/private/asr.key","url":"https://asr.example.invalid/backend-api/transcribe","timeoutMs":120000}}}
```

Merge into media settings; do not replace roots/limits/workers. Legacy configurations
without asrProvider retain Palatine for compatibility, never silently fall back.
Select codexlb explicitly and set your own HTTPS URL in private configuration. Key must allow
gpt-4o-transcribe; no model/reasoning/subtitle request parameters. Private mode0600.
Multipart file with actual filename/MIME, optional prompt; Bearer and
User-Agent codex_cli_rs/0.155.0 (Linux; x86_64), redirects forbidden.
120000ms deadline per attempt covers connection and response body, aborts network.
At most one retry for temporary network/timeout/502/503/504. Auth/429/redirect/
empty or invalid JSON never retry automatically. Safe codes omit response bodies.

Stable fileId/attachmentId/source audio/queue persist. Ready speech keeps its original
source and full text after provider change/restart; no bulk retranscription.
Failed/interrupted stays visible until explicit messenger_transcribe_media
({fileId,retry:true,waitMs:30000}); pending work remains queued/running and status
can be read. No blind retry of interrupted uploads after restart.
Retry uses current purpose and cached original; successful speech source=codexlb.
Registry cache separates provider/settings/SHA256. Legacy table name palatine_results
is retained for additive database compatibility, not provider selection.

Consumers obtain full speech through messenger_message_get/history/file_download;
compact responses explicitly mark clipping and full reads remain available.
media_ready/media_failed events retain source affiliation/version and now use
observation.transport=codexlb_media (Palatine or mts_archive_media for old/upstream
results). Attachment identities and ack/checkpoints are not reset.
connections.inbox.asrProvider reports configured purpose; schema.asrContractVersion=2.
Codex LB returns text only: speakerAttribution=unavailable, no invented timestamps/
speakers. Existing upstream segments remain intact.

Restore source/config for rollback, retaining current DB/journal/ready texts.
No credentials or raw client speech in tracked evidence.

## HUB-029 /0.6.4: historical failed receipts

If a failed file's source differs from configured purpose and the new purpose is
configured, diagnostics add failedProvider/currentProvider/canRetryUsingCurrentProvider
and an explicit same-file retry instruction. Original code/stage/retryable remain
evidence about the previous attempt. Reads never start a retry. No inference about
old HTTP400 balance/format without retained evidence. The prior Palatine-only
migration reset some ready CodexLB files; HUB026 removed that reset and preserves
ready receipts. Historical receipt remains private, no bulk restore/upload.

## HUB-036 /0.7.5: valid empty recognition

A valid JSON object containing a string `text` that trims empty produces terminal
`no_transcript`, `text:null`, `outcome:no_transcript`, `evidence:provider_empty_text`,
`speechPresence:unknown`. This does not prove physical silence or absence of speech,
including a video whose soundtrack contains noise/music/unrecognized speech. Inspect
the original visually. It is not `ready` speech and adds no text to the caption.
Missing/non-string text, arrays/null/invalid JSON remain `asr_invalid_response`;
HTTP and transient transport failures retain existing safe errors/retry semantics.
Same-file retries/restarts/provider changes preserve this terminal result without
re-upload. Digest cache retains the outcome; late subscription emits media_updated
with immutable original source affiliation, not media_failed or fabricated speech.
