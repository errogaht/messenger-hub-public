"""Narrow forum provisioning extension for the existing authenticated bridge.

The bridge retains session ownership. Metadata journals contain operation evidence,
not auth state. An OS lock spans awaits and releases on process death; no lease
expiry can start a second create while the previous process is still executing.
"""
import fcntl
import json
import os
import re
import tempfile
from pathlib import Path
from datetime import datetime, timezone
from telethon import functions, types, utils, errors
from telethon.client.users import UserMethods

ACTIONS = {"inspect", "create", "add_bot", "promote_bot", "general_unhide", "general_open"}


class NoRequestRetries:
    """Reuse the SAME client's sender/session without changing shared retry settings.

    CreateChannel has no application random_id. Telethon's application retries
    must be disabled for these writes; MTProto retransmission of the same message
    stays owned by the existing sender. This is a view, never a new login/client.
    """
    _request_retries = 0
    _raise_last_call_error = True
    flood_sleep_threshold = 0

    def __init__(self, client):
        self.client = client

    def __getattr__(self, name):
        return getattr(self.client, name)


class ForumEngine:
    """Operate only journal-owned private forums; never accept an arbitrary chat ID.

    The random description marker is written as part of CreateChannel itself.
    It allows recovery when the creation response and local ID checkpoint were
    lost. Search is bounded and exact; absence never proves a failed prior create.
    """
    def __init__(self, client, root, account="default", write=None, policy=None):
        # Bridge policy is independently operator-controlled, never copied from
        # MCP request arguments. Missing/invalid policy disables writes safely.
        if policy is None:
            filename = os.getenv("HUB_FORUM_POLICY_FILE")
            policy = {}
            if filename:
                try:
                    source = Path(filename)
                    if not source.is_absolute() or source.stat().st_mode & 0o077:
                        raise ValueError("private_policy_required")
                    policy = json.loads(source.read_text())[account]
                except (OSError, ValueError, KeyError, TypeError):
                    policy = {}
        self.owner = str(policy.get("ownerId", ""))
        self.bot = policy.get("botUsername", "")
        self.title_prefix = policy.get("titlePrefix", "WorkZone · ")
        self.policy_valid = bool(re.fullmatch(r"[1-9][0-9]*", self.owner)
                                 and isinstance(self.bot, str) and re.fullmatch(r"[a-z][a-z0-9_]{4,31}", self.bot)
                                 and isinstance(self.title_prefix, str) and 1 <= len(self.title_prefix) <= 100)
        self.client = client
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        self.account = account
        self.write = write or self._write
        self.row = None

    async def _write(self, request):
        return await UserMethods._call(NoRequestRetries(self.client), self.client._sender, request, flood_sleep_threshold=0)

    def save(self, path, row):
        # Atomic metadata replacement precedes every external mutation; never
        # truncate a checkpoint or remove a created group during rollback.
        with tempfile.NamedTemporaryFile(mode="w", dir=self.root, delete=False) as file:
            os.chmod(file.name, 0o600)
            json.dump(row, file)
            file.flush()
            os.fsync(file.fileno())
            temporary = file.name
        os.replace(temporary, path)
        directory = os.open(self.root, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    async def identity(self):
        me = await self.client.get_me()
        return {"id": str(me.id), "isSelf": bool(getattr(me, "is_self", False)), "isBot": bool(getattr(me, "bot", False))}

    def error(self, code, action, unknown=False):
        # Only classifications are public: native error bodies/paths never escape.
        return {**({"conversationId": self.row["conversationId"], "botId": self.row["botId"]} if self.row and self.row.get("conversationId") else {}), "status": "unknown" if unknown else "blocked", "stage": action,
                "diagnostic": {"code": code, "stage": action, "retryable": code == "group_rate_limited",
                               "description": code.replace("_", " ")},
                **({"reconciliation": self.row["reconciliation"]} if self.row and self.row.get("reconciliation") else {})}

    async def entity(self, row):
        chat = row.get("conversationId")
        if not chat:
            return None
        try:
            return await self.client.get_entity(int(chat))
        except ValueError:
            async for dialog in self.client.iter_dialogs(limit=501):
                if str(utils.get_peer_id(dialog.entity)) == chat:
                    return dialog.entity
            raise

    async def reconcile(self, row, path):
        if row.get("conversationId"):
            return await self.entity(row)
        # Do not compare titles. The marker is a unique creation-time proof and
        # the native creator must be the expected currently authenticated owner.
        matches = []
        scanned = 0
        async for dialog in self.client.iter_dialogs(limit=501):
            scanned += 1
            if scanned > 500:
                break
            entity = dialog.entity
            if not isinstance(entity, types.Channel) or not getattr(entity, "creator", False) or not getattr(entity, "megagroup", False):
                continue
            full = await self.client(functions.channels.GetFullChannelRequest(channel=entity))
            if getattr(full.full_chat, "about", "") == row["marker"]:
                matches.append(entity)
        row["reconciliation"] = {"scanned": min(scanned, 500), "complete": scanned <= 500, "matches": len(matches)}
        if len(matches) == 1 and scanned <= 500:
            row["conversationId"] = str(utils.get_peer_id(matches[0]))
            row["pending"] = None
            self.save(path, row)
            return matches[0]
        self.save(path, row)
        return None

    async def observe(self, row, entity):
        full = await self.client(functions.channels.GetFullChannelRequest(channel=entity))
        if full.full_chat.about != row["marker"] or not getattr(entity, "creator", False):
            return self.error("group_identity_evidence_mismatch", "verify")
        participants = await self.client(functions.channels.GetParticipantsRequest(channel=entity, filter=types.ChannelParticipantsRecent(), offset=0, limit=100, hash=0))
        ids = sorted(str(p.user_id) for p in participants.participants)
        complete = participants.count == len(ids)
        owner = next((p for p in participants.participants if str(p.user_id) == self.owner), None)
        bot = next((p for p in participants.participants if str(p.user_id) == row["botId"]), None)
        owner_creator = isinstance(owner, types.ChannelParticipantCreator)
        admin = isinstance(bot, types.ChannelParticipantAdmin)
        rights = getattr(bot, "admin_rights", None)
        # No arbitrary invite/add-admin privilege is granted. Enumerate all flags
        # from the installed TL type so a future new true permission is detected.
        granted = sorted(k for k, v in (rights.to_dict() if rights else {}).items() if k != "_" and v is True)
        # Telegram normalizes promoted admins with the baseline `other` flag.
        # It grants no invite_users/add_admins/content-management permission.
        # Accept only this baseline plus the explicitly requested manage_topics.
        bot_rights_exact = admin and "manage_topics" in granted and set(granted).issubset({"manage_topics", "other"})
        topics = await self.client(functions.messages.GetForumTopicsByIDRequest(peer=entity, topics=[1]))
        general = next((t for t in topics.topics if getattr(t, "id", None) == 1), None)
        general_exists = isinstance(general, types.ForumTopic)
        general_visible = general_exists and not bool(getattr(general, "hidden", False))
        general_open = general_exists and not bool(getattr(general, "closed", False))
        public_names = bool(getattr(entity, "username", None)) or any(getattr(u, "active", False) for u in (getattr(entity, "usernames", None) or []))
        private = not public_names and not getattr(full.full_chat, "linked_chat_id", None)
        forum = bool(getattr(entity, "forum", False)) and bool(getattr(entity, "megagroup", False))
        exact = complete and ids == sorted([self.owner, row["botId"]])
        allowed_members = complete and set(ids).issubset({self.owner, row["botId"]}) and owner_creator
        if not private or not forum or not allowed_members:
            return self.error("group_privacy_forum_or_membership_mismatch", "verify")
        done = ["create"]
        if bot:
            done.append("add_bot")
        if bot_rights_exact:
            done.append("promote_bot")
        if general_visible:
            done.append("general_unhide")
        if general_open:
            done.append("general_open")
        verification = {"private": private, "forum": forum, "ownerIsCreator": owner_creator,
                        "participantIds": ids, "participantsComplete": complete, "participantsExact": exact,
                        "botIsAdmin": admin, "botRights": granted, "botRightsExact": bot_rights_exact,
                        "general": {"id": "1", "exists": general_exists, "hidden": not general_visible, "closed": not general_open},
                        "ready": exact and bot_rights_exact and general_visible and general_open,
                        "checkedAt": datetime.now(timezone.utc).isoformat()}
        return {"status": "ok", "conversationId": row["conversationId"], "botId": row["botId"],
                "openUrl": f"https://t.me/c/{entity.id}/1", "verification": verification, "completedStages": done}

    async def step(self, operation_key, marker, title, bot_username, expected_owner_id, action, create_uncertain=False):
        if not self.policy_valid or action not in ACTIONS or expected_owner_id != self.owner or bot_username != self.bot or not title.startswith(self.title_prefix) or len(title) > 128 or not re.fullmatch(r"WZ-Hub:[a-f0-9]{48}", marker) or not re.fullmatch(r"[a-f0-9-]{36}", operation_key):
            return self.error("group_policy_violation", "validation")
        identity = await self.identity()
        if identity != {"id": self.owner, "isSelf": True, "isBot": False}:
            return self.error("group_owner_mismatch", "identity")
        path = self.root / (operation_key + ".json")
        lock = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return self.error("group_operation_in_progress", action, True)
            expected = {"marker": marker, "title": title, "botUsername": bot_username, "account": self.account, "ownerId": self.owner}
            row = json.loads(path.read_text()) if path.exists() else None
            self.row = row
            if row and any(row.get(k) != v for k, v in expected.items()):
                return self.error("group_operation_conflict", "validation")
            bot = await self.client.get_entity(bot_username)
            if not isinstance(bot, types.User) or not bool(getattr(bot, "bot", False)) or (getattr(bot, "username", "") or "").lower() != self.bot:
                return self.error("group_bot_invalid", "identity")
            if row and row["botId"] != str(bot.id):
                return self.error("group_bot_identity_changed", "identity")
            if row is None:
                row = {**expected, "botId": str(bot.id), "pending": "create" if create_uncertain and action == "inspect" else None, "conversationId": None}
                self.save(path, row)
                self.row = row
            entity = await self.reconcile(row, path) if row.get("pending") == "create" else await self.entity(row)
            if entity is None and row.get("pending") == "create":
                return self.error("group_creation_unconfirmed", "create", True)
            if entity is None and action == "inspect":
                return {"status": "ok", "completedStages": [], "conversationId": None}
            if entity is None and action != "create":
                return self.error("group_creation_required", action)
            if entity is not None:
                observation = await self.observe(row, entity)
                if observation["status"] != "ok" or action == "inspect" or action in observation["completedStages"]:
                    return observation
                if action == "create":
                    return observation
            # This durable intent is visible after a crash or lost MCP response.
            row["pending"] = action
            self.save(path, row)
            if action == "create":
                response = await self.write(functions.channels.CreateChannelRequest(title=title, about=marker, megagroup=True, forum=True))
                channels = [c for c in response.chats if isinstance(c, types.Channel) and getattr(c, "megagroup", False)]
                if len(channels) != 1:
                    return self.error("group_creation_unconfirmed", action, True)
                entity = channels[0]
                row["conversationId"] = str(utils.get_peer_id(entity))
            elif action == "add_bot":
                await self.write(functions.channels.InviteToChannelRequest(channel=entity, users=[bot]))
            elif action == "promote_bot":
                await self.write(functions.channels.EditAdminRequest(channel=entity, user_id=bot, admin_rights=types.ChatAdminRights(manage_topics=True), rank="WorkZone"))
            elif action == "general_unhide":
                await self.write(functions.messages.EditForumTopicRequest(peer=entity, topic_id=1, hidden=False))
            elif action == "general_open":
                await self.write(functions.messages.EditForumTopicRequest(peer=entity, topic_id=1, closed=False))
            row["pending"] = None
            self.save(path, row)
            return await self.observe(row, entity)
        except errors.RPCError as error:
            # Server errors and timeouts may follow a committed write. Only a
            # reviewed explicit rejection permits retrying the same failed stage.
            known = {"ChatAdminRequiredError": "group_admin_required", "UserPrivacyRestrictedError": "group_bot_invite_denied",
                     "UserNotMutualContactError": "group_bot_invite_denied", "UserRestrictedError": "group_owner_restricted",
                     "ChannelsTooMuchError": "group_limit_reached", "BotsTooMuchError": "group_bot_invite_denied",
                     "BotGroupsBlockedError": "group_bot_invite_denied", "UserBannedInChannelError": "group_bot_invite_denied",
                     "FloodWaitError": "group_rate_limited"}
            if type(error).__name__ == "TopicNotModifiedError" and row and row.get("conversationId"):
                row["pending"] = None
                self.save(path, row)
                return await self.observe(row, await self.entity(row))
            code = known.get(type(error).__name__)
            if code and row:
                row["pending"] = None
                self.save(path, row)
            return self.error(code or "group_provider_unconfirmed", action, code is None)
        except Exception:
            return self.error("group_provider_unconfirmed", action, True)
        finally:
            os.close(lock)


# Registration imports the existing runtime ONLY in the installed bridge. Unit
# tests load the engine before this boundary, without creating an authenticated client.
from telegram_mcp.runtime import mcp, with_account, get_client, ToolAnnotations


@mcp.tool(annotations=ToolAnnotations(title="Hub Forum Identity", readOnlyHint=True))
@with_account(readonly=False)
async def hub_forum_identity(account: str = None) -> str:
    """Return only the actual self ID from the existing connected account."""
    me = await get_client(account).get_me()
    return json.dumps({"id": str(me.id), "isSelf": bool(me.is_self), "isBot": bool(getattr(me, "bot", False))})


@mcp.tool(annotations=ToolAnnotations(title="Hub Forum Step", readOnlyHint=False, destructiveHint=False))
@with_account(readonly=False)
async def hub_forum_step(operation_key: str, marker: str, title: str, bot_username: str,
                         expected_owner_id: str, action: str, create_uncertain: bool = False, account: str = None) -> str:
    """Narrow internal bridge API, off by default; no arbitrary user or group ID."""
    if os.getenv("HUB_FORUM_PROVISIONING", "0") != "1":
        return json.dumps({"status": "blocked", "stage": "authorization", "diagnostic": {"code": "group_bridge_disabled"}})
    root = os.getenv("HUB_FORUM_JOURNAL")
    if not root or not Path(root).is_absolute():
        return json.dumps({"status": "blocked", "stage": "journal", "diagnostic": {"code": "group_bridge_journal_missing"}})
    engine = ForumEngine(get_client(account), root, account or "default")
    return json.dumps(await engine.step(operation_key, marker, title, bot_username, expected_owner_id, action, create_uncertain))
