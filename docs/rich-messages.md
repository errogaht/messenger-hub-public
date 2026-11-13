# Native Telegram Rich Messages

Smart `messenger_contact_prepare` / `messenger_contact_send` accept optional
`format`: `auto` (omission), `plain`, `rich_markdown`, `rich_html`. Auto supplies
Telegram's native rich Markdown as the model default; substantive client reports
should use headings, compact tables, labeled links and useful code blocks. Long
secondary details should use rich HTML with closed `details` sections. Short
personal messages do not need artificial report structure. The prompt lives in
`prompts/rewrite.md`, independent of old contact-profile examples.

The preview returns the actual markup and chosen `format`. Both are frozen in the
private operation ledger. Send the original source payload and requestId to dispatch
that preview. Changing the requested format requires a new intent/request, never
an automatic retry after an unknown delivery. Old stored operations without a
format keep their original plain behavior and idempotency digest.

Raw/legacy send and delivery accept optional `format` with default plain. An explicit
rich format renders already prepared markup without LLM rewriting. Other providers
reject unsupported rich modes before any send. Existing WorkZone callers are unchanged.
Telegram plain limit remains 4096; Hub rich markup limit is conservatively 30000
JavaScript string units, below Telegram's 32768 text-character bound. Telegram also
applies block/nesting/media limits; a rejected request never triggers plain fallback.

The existing Telegram bridge receives `parse_mode=rich_markdown` or `rich_html`,
including replies. It returns server-correlated message IDs. Hub reads the exact
ID in the selected chat and requires our sender, the expected reply target,
nonpartial native rich blocks, and requested heading/table/details/photo types.
Rendered text is not compared to source markup. Failure or lost response remains
`unknown`: neither success nor proof of nondelivery; do not resend under a new ID.
Structural checks are conservative, not a complete markup parser or visual verifier.
History already contains a readable rich-text projection from the bridge; it is not
lossless markup and does not expose the complete native block tree.

URL images use real accessible image blocks between paragraphs. The bridge does not
expose local file uploads for rich content. Do not publish private screenshots to
create a URL. URL-image rendering has not been live-tested here; obtain an authorized
non-client test before first client use. This release made no external sends.

Verification: fake send/reply/readback and idempotency tests, live read-only inspection
of existing Saved Messages rich headings/table/details, and a synthetic live model
preview producing rich HTML table/details with protected values intact. Owner visual
acceptance of a new Hub-delivered message remains separate.

Rollback: restore the previous source archive recorded in HUB-005 and restart
messenger-hub.service. Preserve delivery/contact/media databases. Expire or avoid
pending rich previews after rollback (the old code cannot deliver them correctly).
The direct Telegram MCP/skill remain disabled in Codex; this release does not change
that configuration or the underlying Telegram session/service.

Source: [Telegram Rich Message formatting](https://core.telegram.org/bots/api#rich-message-formatting-options).
