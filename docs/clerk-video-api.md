# Clerk video API — contract1 (HUB-039)

Phase: FINAL / INSTALLED — Hub0.8.0, video contract1, 2026-10-10. Ownership: Hub/core/bridge/Video Review
wrapper here; no Clerk edits. Proposed Clerk draft v1 accepted with these explicit
clarifications: frames require a downloaded original (otherwise video_not_cached,
call prepare or existing file_download); status/read never download, upload or poll
provider; thumbnail never fetches original as fallback. No paid/live ASR acceptance
is implied by installation. Ordinary audio CodexLB and MTS unchanged.

MCP names below have messenger_ prefix; local HTTP uses existing authenticated
POST /api/v1/call with {"method":"video_status","input":{"fileId":"…"}}
(and corresponding method/input for each operation). Existing scope read grant on the exact
registered source is required for every call and derivative /files/:id. No paths,
URLs, callback URLs, model choice or provider keys accepted from tool callers.

- video_thumbnail({fileId}): {status:ready|unavailable|pending,thumbnail:null|
  {fileId,mimeType,sha256,width,height},durationSeconds?,width?,height?}. Cached or
  native Telegram preview only. Missing native poster = unavailable, no original.
- video_prepare({fileId,waitMs:0}): returns manifest, joins durable/cache-first job.
  waitMs integer0..30000, default0. Downloads only this explicit file, shared
  Palatine async/SRT purpose (settings), no CodexLB fallback or bulk admission.
- video_status({fileId}): same manifest, cache-only. Pending known paid IDs resume
  GET in worker on restart; unknown submission never retries POST.
- video_read({fileId,offset:0,limit:100}): {segments:[{start,end,text}],offset,
  nextOffset:null|integer,total,durationSeconds,sha256}; limit1..100. Source video
  seconds, complete segments, no silently shortened text. Not-ready explicit error.
- video_frames({fileId,timestamps:[0.0],crop?:{x,y,width,height}}): cached original
  only,1..12 finite nonnegative timestamps strictly within video duration.
  {sha256,durationSeconds,frames:[{fileId,mimeType,sha256,width,height,seconds,
  crop?,precision}]}. Original-resolution PNGs; crop is source coordinates.
  Precision describes seek request/source-frame quantization, not fabricated
  exact decoded presentation timestamps. No arbitrary filesystem or provider IO.

Manifest: {fileId,status:queued|downloading|transcribing|ready|failed|submission_unknown,
durationSeconds?,hasAudio?,sha256?,segmentCount?,progress:{phase},error?:{code,retryable}}.
No-audio => ready/hasAudio:false/segmentCount:0. Empty or invalid ASR is never called
proof of silence; known provider receipt remains preserved. Progress is phase-only
unless actual bytes are measured. Derivative sha identifies artifact, outer sha
identifies original; UUID authorization always resolves original source route.

Attachment optional video:{durationSeconds?,width?,height?,thumbnailFileId?,
status?,hasAudio?,sha256?,segmentCount?,timelineAlignment?,error?}. The same cached
summary appears in history/message_get/context and compact inbox/replay events.
status uses the manifest enum; sourceText/text/caption are never replaced by video
transcript. Read complete transcript through video_read pages.

Terminal job saves emit the EXISTING durable/scoped readiness envelopes:
ready -> kind:media_ready; failed -> media_failed; submission_unknown ->
media_updated. Each carries fileId, mediaRevision, unchanged source.versionHash
and version, and message.attachments[].video.status. Progress states do not emit
triage wakeups. The original ingestion.sourceOrigin affiliation is retained
(activity.classification:media_update, observation.phase:late_media,
observation.transport:palatine_video_review_media). Historical imports remain
historical even after ASR; an unknown submission wakes the consumer to show the
blocker, never requests an automatic new POST. Identical terminal saves dedup.
Ack/replay/SSE use their existing contracts; reconnect resumes from durable
cursor. Clerk may re-enter waiting_media using that fileId/mediaRevision and
read cached artifacts, without retrying provider ASR. Restart reconciles saved
terminal jobs and pending known paid tasks. No worker or native grant is enabled
by this feature.
Metadata reads do not download media or run ASR. Preview may be unavailable on
unsupported channels. Original download size limits remain existing media limits.

Shared core: canonical repository video-review/, same default
~/.cache/codex-video-review/<content+compatible-profile hash>, task.json + SRT.
CLI remains standalone with thin wrapper; no Hub daemon required. Key rotation
does not change identity. Default legacy OS-account namespace preserves receipts;
changing account namespace/profile intentionally separates cache. No forced retry
for failed/unknown paid receipts. Scope is checked before shared-cache artifacts
are disclosed. No task decisions, models for routing, client sends or orchestration.

Integration sequence: message_get -> attachment.fileId -> thumbnail; explicit
prepare -> status -> read pages until nextOffset=null; frames at selected times ->
existing file_download for native image or authenticated GET /files/:id. Source
edit/version/digest must remain attached to consumer decisions. No ack/task effect
is performed by these factual-artifact tools.

Additional factual field: manifest/read `timelineAlignment` is
`source_zero_padded` for new source-preserving extraction, or `legacy_unverified`
for compatible older artifacts whose extraction alignment cannot be proven.
Frame descriptors also retain sourceFileId/sourceVersion. No automatic timestamp
shift or new paid job is applied to legacy SRT. Invalid input -> video_input_invalid;
not-ready -> video_not_ready; lock busy -> video_cache_busy (safe read retry).

Example local calls (Bearer from existing private scope store, never in source):
```json
{"method":"video_prepare","input":{"fileId":"REGISTERED-VIDEO-UUID","waitMs":0}}
{"method":"video_read","input":{"fileId":"REGISTERED-VIDEO-UUID","offset":0,"limit":100}}
{"method":"video_frames","input":{"fileId":"REGISTERED-VIDEO-UUID","timestamps":[12.2],"crop":{"x":0,"y":0,"width":640,"height":480}}}
```
The `clerk_video_*` names are consumer adapter wrappers, not additional Hub tools.
Full PNG/crop bytes use the existing scoped /files/:id or native image MCP path.
Keep derivative identity, sourceFileId/sourceVersion and source digest in the
host evidence journal before forwarding an image to a native agent turn.

Hub0.8.3/download contract1: original `file_download` now has optional
waitMs0..25000(default25000). Long transfers return status:downloading with
path:null and retryAfterMs; repeat SAME fileId untilready. This is ordinary
progress, not a blocked provider or an ASR retry. Native preview/status/read
remain inert; video_prepare already uses the internal transfer and needs no
consumer/provider resubmission. Existing /files/:id works forready originals.

Hub0.8.4: verified cached original can recover a failed pre-ASR download on the
next explicit video_prepare. status remains failed until that call, but exposes
canResume:true,error:{code,stage:download,retryable:true} and nextAction.
Recovery preserves the frozen profile. Durable coreStarted/sha and paid terminal/
unknown receipts fence automatic retries. No job/cache deletion or bulk retries.
error.stage is additive; ready clears obsolete transient errors. This recovery
may proceed to the owner-requested ASR once, so it is not a cache-only read.
