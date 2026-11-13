# Installation and per-installation settings

This is a self-hosted source release for Linux, with Node.js >=22.13 and Python 3.
Optional video extraction needs FFmpeg/ffprobe and Python requests. Telegram bridge
extensions need Telethon and a compatible existing Telegram MCP distribution;
that distribution, GOWA, Bitrix and MTS archive are installed separately.
Provider sessions stay with their bridges. No account, provider key or ready-made
operator credential ships with the source.

```sh
npm ci
npm test
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python test/telegram-bridge-forum.py
.venv/bin/python video-review/test_core.py
mkdir -p "$HOME/.config/messenger-hub"
cp config.example.json "$HOME/.config/messenger-hub/config.json"
chmod 600 "$HOME/.config/messenger-hub/config.json"
```

Edit the copy: set absolute plugin paths to this checkout, a private writable store,
your connection settings and a random token (`openssl rand -hex 32`). The example
uses Bitrix and a pinned operator-owned SSH launcher; it is a template, not a
working account. Leave send disabled until you intentionally grant it. Then run:

```sh
MESSENGER_HUB_CONFIG="$HOME/.config/messenger-hub/config.json" npm start
```

`GET http://127.0.0.1:8792/health` is a liveness check. Authenticated MCP uses `/mcp`.
For STDIO create a separate mode-0600 credential JSON containing
`{"url":"http://127.0.0.1:8792/mcp","token":"YOUR_RANDOM_SCOPE_TOKEN"}` and set
`MESSENGER_HUB_CREDENTIAL` when launching `node /absolute/checkout/src/stdio.mjs`.

## Forum groups: independent policies

Provisioning is default-off. In the Hub's private config configure
`groupProvisioning.connections.<connectionId>` with `enabled`, `policyId`, your
numeric string `ownerId`, lowercase `botUsername`, `titlePrefix` and allowed
`clientKeys`; grant groups.ensure/read separately to the intended scope.

The bridge additionally requires `HUB_FORUM_PROVISIONING=1`, an absolute private
`HUB_FORUM_JOURNAL`, and `HUB_FORUM_POLICY_FILE` pointing to a mode-0600 JSON file:

```json
{"default":{"ownerId":"100000001","botUsername":"example_forum_bot","titlePrefix":"WorkZone · "}}
```

IDs here are synthetic. Keys select the bridge account label (`default` when no
label is supplied). Set the same owner/bot/prefix in both policies. Tool callers
cannot choose a new policy. The bridge verifies get_me, bot identity, exact group
membership and narrow admin rights. Policy changes cannot adopt old operations.
Legacy forum journals lacking ownerId fail with group_operation_conflict; preserve
these journals and reconcile deliberately instead of recreating groups.

## ASR and model settings

`media.codexlb.url` is a required operator-selected HTTPS transcription endpoint;
`keyFile` points to your private subscription key. No personal endpoint is built
in. The legacy `media.asrUrl` has no default. Palatine endpoints remain provider
protocol constants. Choose providers and models in private purpose settings;
keys, URLs and models cannot be supplied by message tools. Transcription can incur
provider charges. Leave optional ASR disabled until configured.

## Optional local extensions

The native Telegram lifecycle patch requires absolute
`MESSENGER_HUB_UPDATES_MODULE=/your/checkout/bridges/telegram-hub-updates.py` in the
bridge environment before restart. Review patch compatibility with your bridge.
Ingest still requires its separate private opt-in configuration and exact grants.

The Video Review wrapper resolves its core from `VIDEO_REVIEW_CORE`, then
`~/.config/messenger-hub/video-review.json` (`corePath`), then its source checkout.
`scripts/install-video-review.py` writes this private setting and backs up prior
values. It does not start paid jobs. Read installers before use: the optional
Telegram recovery installer manages user systemd services and assumes an existing
bridge layout. `install-telegram-read.py --bridge` selects the existing bridge checkout.
`install-telegram-recovery.py --bridge ... --config ...` configures both paths
for the recovery service. `telegram-recovery.py --bridge` also supports a direct override.

## Migration and rollback

There is no silent fallback to an author's account or server. Before upgrading an
existing private installation, explicitly set its ASR URL and bridge forum policy,
set the native extension path and back up configuration and metadata journals.
Restart only your intended services. Do not replace live databases or sessions
with old snapshots: newer messages and unknown receipts must be preserved.
The release was tested with fake provider transports; universal end-to-end provider
compatibility and fresh login are not implied by passing these tests.
