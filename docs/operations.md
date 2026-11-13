# Operations and rollback

Private config contains plugin module paths, connection settings, and scope tokens.
Never put it in Git, argv, audit output or screenshots. Credentials do not contain
provider secrets; provider bridges keep their existing login/session ownership.
The legacy transport journal stores hashes/identifiers only (0600). The optional
contact assistant has a separate private SQLite store containing contacts and prepared
message text for durable replay, plus Markdown profiles; see `contact-agent.md`.
Profile bodies and attachment
bytes pass only through authenticated calls and are not logged. Downloaded media
stays within the existing configured private media root.

Installation: pinned npm dependencies, explicit local modules, private config,
loopback systemd user service, project-scoped STDIO registrations. Configuration
changes require restart. Back up config and journal privately before migration.

Disable service with systemctl --user disable --now messenger-hub.service. Restore
previous MCP configuration and WorkZone runner environment from their private
backups; existing Telegram/GOWA/Bitrix tools remain independent. Do not remove the
journal until all unknown deliveries have been reconciled manually.

MCP scopes protect calls, not a malicious process with arbitrary shell access as
the same Unix user. Such a process can read that user's files or contact legacy
bridges. Strong host isolation requires separate OS credentials/sandbox; do not
claim project tools alone implement that stronger boundary.

A plugin failure surfaces a bounded error. Never expose raw provider exceptions or
credentials. Do not automatically retry sends on reconnect. Read retries are safe
and must not advance the consumer cursor on incomplete history.

The existing WhatsApp skill has a narrow local compatibility section for
Messenger Hub. Its authorization, contact profile creation and style rules are
unchanged; a private pre-edit backup is retained under .private/backups. The
Telegram skill is unchanged. Install the included messenger-communication skill
for other channels and scoped portal routing.

The shipped Bitrix adapter targets self-hosted portals reachable through a pinned
SSH launcher and native Bitrix PHP. A cloud-only portal without that transport
needs a REST-based plugin; it can use the same hub contract without WorkZone changes.

HUB-003 adds private media files, content-hash ASR cache and scope-bound wait cursors.
These stores contain bodies and are separate from the metadata-only transport journal.
Keep them across restarts/rollback; see `media-search-wait.md`. The existing CodexLB key
also allows gpt-4o-transcribe for subscription ASR; Voice Input keys/config are unchanged.

HUB-017 adds default-off owner-only group provisioning. Keep BOTH the Hub journal
hub_groups/hub_group_requests/hub_group_audit and the bridge's forum metadata
journal across restarts/rollback. They contain group identity/progress, not provider
login state. Never reconstruct an unknown create from a group title. See
[forum groups](telegram-forum-groups.md) for narrowly scoped activation and recovery.

## HUB-018: durable subscriptions/inbox (0.4.0)
Шесть additive операций: subscription_save/status, inbox_consumer_ensure/claim/ack/event_get.
Wire2/plugin1 сохраняются. Отдельные scope inbox.read/manage + текущий exact route read;
send не выдаётся. HTTP worker default off; page checkpoint и consumer ack независимы.
Lease/replay, immutable edits/media supplements, Palatine-only subscription ASR,
ограничения provider polling и rollback: [durable-inbox.md](durable-inbox.md).

## Telegram read addressing (HUB-043, 0.8.6)

The adapter requires the pinned `bridges/telegram-hub-read.py` extension in the
existing Telegram MCP tools package. Run `python3 scripts/install-telegram-read.py`
and restart the existing `telegram-mcp.service` and `messenger-hub.service` user
services. The installer backs up module registration under `.private/hub043-rollback/bridge`;
it never touches session files. The installed messenger-communication skill is
already a symlink to this repository's skill source.

Verify public schema/source identity and `history` with the requested peer link,
`readMode:refresh`, `limit:30`, optionally `transcribeAudio:false`. Canonical
`conversationId` must equal the provider-marked numeric ID. Cached title lookup
never proves uniqueness from one observed candidate; refresh or a confirmed ID
is required. Catalog pagination is live metadata, not a frozen peer snapshot.

For rollback restore the previous Hub source and backed-up Telegram tools
registration; remove `hub_read.py` only if it did not exist before installation.
Restore the skill source and restart both existing services. Retain every
DB/cache/file UUID, uncertain delivery, subscription and Telegram session.
