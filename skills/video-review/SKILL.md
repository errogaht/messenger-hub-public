---
name: video-review
description: Understand local videos and work screencasts using Palatine timestamped transcription followed by selective FFmpeg frames and visual inspection. Use when asked to watch a video, understand an on-screen demonstration, or extract requirements from a recording, including downloaded messenger attachments.
---

# Video review

Interpret spoken explanations together with what is actually visible on screen. This skill works on local files independently of Telegram or Messenger Hub. Obtain attachments through the authorized connector first; do not bypass a failed connector or guess missing media content.

## Tools and credentials

Use `scripts/video-review.sh` relative to this skill's resolved directory. Examples below use the installed personal path; the corporate installation is a symlink to it:

```bash
VR="$HOME/.codex/skills/video-review/scripts/video-review.sh"
"$VR" transcribe --file "/absolute/path/screencast.mp4"
```

Requires Python 3 with `requests`, FFmpeg and FFprobe. On this workstation these are installed. Credential and model configuration: [references/configuration.md](references/configuration.md). Do not print keys. The selected model belongs in settings, never in a command handler or prompt.

## Review workflow

1. Run `transcribe`. It extracts the first audio stream as mono 16 kHz Opus and submits one async Palatine task, requesting SRT on retrieval. No trimming, silence removal or speed change: audio times stay aligned to the source video. `prepare` performs only local extraction; `lookup` checks saved status.
2. Exit **11** means the saved task is pending or its status could not be fetched. Run the same `transcribe` command again to resume that ID. Use a yielding execution session for the potentially long upload; continue reporting progress. Exit **10** is a lookup cache miss; **12** means another process holds the video lock. Other failures require diagnosis, not blind retries.
3. Read the **entire** `transcript.srt` (in chunks for long videos) and `segments.json` from the returned cache path. Identify demonstrations, requests, navigation, errors and ambiguous references such as “here”, “this button”, “like that”. Do not conclude from speech alone.
4. Get a small visual overview, then select timestamps based on speech and gaps:

```bash
"$VR" frames --file "/absolute/path/screencast.mp4" --count 8
"$VR" frames --file "/absolute/path/screencast.mp4" --timestamps "00:01:12.200,00:01:13.000,00:01:14.500"
"$VR" frames --file "/absolute/path/screencast.mp4" --timestamps "73.0" --crop "200:100:900:600"
```

5. **Open and inspect the resulting images** with the image viewing tool. Merely generating files is not watching the video. Use original detail for small screen text; inspect full PNGs before crops so context is preserved. No OCR or extra AI service is needed. Crops use source coordinates `x:y:width:height`; full frames remain available.
6. Around clicks, cursor pointing, scrolling, hover text and state changes, sample before/during/after the event, often 0.3–1 seconds apart. Speech may precede or follow the visible action: expand the time window until the intended control and outcome are clear. Sample silent stretches and transitions too. Increase coverage where important detail might occur between overview samples. For long videos work section by section; each invocation accepts up to 60 frames. Do not claim exhaustive coverage from a few samples.
7. Report what the speaker requests, what the interface shows, and any remaining uncertainty. Cite video times and concrete labels/paths/values. Separate current behavior from requested behavior, and verified observations from inference. A request to watch or diagnose does not itself authorize implementing every spoken request. Follow the actual project scope when extracting actionable tasks.

## Failure and resumption

The shared private cache is `~/.cache/codex-video-review/<content-and-profile-hash>/`; both Codex homes reuse it. It contains original source metadata, extracted audio, provider task receipt, SRT cues and timestamped PNG evidence. `frames.json` accumulates extracted frames. Filenames and returned manifests identify the source hash and exact requested seek position; decoded frames follow the source frame rate.

An OS file lock prevents concurrent paid uploads. A receipt is persisted **before** POST; interrupted/ambiguous submissions stop in `submitting` or `submission_unknown`. **Do not delete receipts/cache to retry**, change the model to bypass a failed task, or auto-resubmit terminal failures. Reconcile with the provider/operator; if a known task ID is recovered, persist it in `task.json` with state `pending` under the same lock before resuming. Retain the original receipt as evidence. A provider `success` without valid SRT is also a blocker; the known ID stays reusable.

For a source with no audio, inspect frames and explicitly describe the review as visual only. If a required transcription or media connector fails, stop the dependent interpretation, preserve the cache checkpoint, and tell the owner the exact step and safe error. Do not switch transcription providers or ask a customer to resend because an internal tool failed.

Media/transcripts can contain private work. Keep the cache private and do not publish it or send anything to another person. Remove artifacts only when no longer needed and no unresolved provider task remains. Palatine receives only extracted audio; screenshots remain local.

## Shared Hub core

The installed CLI is a thin entry point to the canonical
`<checkout>/video-review/core.py`. It remains usable
without a running Hub daemon. Hub `messenger_video_prepare/status/read/frames`
uses the same content/profile identity, OS lock, paid receipt and SRT cache;
reuse existing artifacts instead of paying twice. Configuration defaults are
canonical in that repository's `video-review/references/defaults.json`; user
settings remain `~/.config/codex-video-review/settings.json`. Install/reinstall
with the repository `scripts/install-video-review.py`; it backs up changed
installed files without touching credentials, cache or active task receipts.
New extraction preserves source-zero timeline padding. Existing artifacts remain
reusable but their alignment is `legacy_unverified`; never fabricate offsets.
Hub thumbnails use scoped native Telegram previews without original download.
Hub frame requests allow at most12 timestamps; standalone CLI retains its60-frame
limit. Hub readiness events supplement the source and never change its caption.
