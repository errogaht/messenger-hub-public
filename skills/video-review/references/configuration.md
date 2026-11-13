# Local configuration

The shared credential file on this workstation is `~/.config/codex-video-review/palatine.env` (mode 0600, directory 0700). It contains `PALATINE_API_KEY=...`. The initial key was copied privately from the existing voice-input installation; the skill no longer depends on that project's directory or the legacy Telegram skill. Never copy a secret into the skill folder, command line, Git or output.

Environment variable `PALATINE_API_KEY` overrides the file; `PALATINE_ENV_FILE` selects another dotenv file. Dotenv is parsed as data, not executed. Only the key is read from it: voice-input's synchronous endpoint must not override this skill's async protocol.

Default transcription settings live in [defaults.json](defaults.json). Optional `~/.config/codex-video-review/settings.json` overrides fields for subsequent runs. Model choice is `model`; there is no reasoning parameter for this speech recognition API. Changing model or endpoints creates a separate cache profile; finish/reconcile existing paid tasks before intentionally changing profiles. Key rotation does not change cache identity. If using another Palatine account, use a separate OS user/cache location rather than mixing receipts.

The cache location deliberately ignores `CODEX_HOME` so the personal and Kafoodle symlink share results. `~` denotes the actual OS user's home in both environments. Inputs must be local readable files; authenticated media downloading belongs to the relevant connector.

Protocol source: [Palatine polling principles](https://docs.speech.palatine.ru/documentation/technical_information/polling_principles), verified 2026-10-10. POST `/api/v1/transcribe/do_transcribe` uploads multipart `file`, with `model` and `fast_inference` query parameters; GET `/api/v1/transcribe/task_status/{task_id}?response_format=srt` retrieves status and timecoded text. This contract also matches the existing local Telegram video helper. No task-done/deletion call is made, preserving resumability.

Exit codes: 0 success; 1 failure; 10 lookup miss; 11 pending/read-only network interruption; 12 lock busy. A pending result is not a transcript. The CLI prints artifact paths and metadata as JSON, with progress on stderr. Read SRT explicitly after success.

For installation on another machine, install system FFmpeg and Python `requests` using its normal package/environment manager. Credentials and media cache are intentionally not packaged with the skill.

Canonical runtime defaults: messenger-hub/video-review/references/defaults.json.
The installed copy is documentation only. `VIDEO_REVIEW_SETTINGS_FILE` selects
an optional private settings JSON; `account_namespace` explicitly isolates a
new account while the default absent field preserves legacy cache identities.
`VIDEO_REVIEW_CACHE` selects an isolated cache for offline tests; production CLI
and Hub must keep the shared default. `VIDEO_REVIEW_CORE` overrides the local
wrapper's canonical source path for installations on another machine.
