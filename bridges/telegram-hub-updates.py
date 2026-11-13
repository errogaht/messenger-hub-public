"""Opt-in native forwarding on the EXISTING Telethon client, never a new session.

Only configured chat IDs are persisted. A FULL/WAL outbox commits before HTTP;
missing/lost Hub receipts replay the same event key. Retry backoff is transport
recovery, not provider polling. No message body/token is printed or logged.
"""
import asyncio
import hashlib
import json
import os
import sqlite3
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


_active_forwarder = None

def mention_evidence(message):
    """Only Telegram entity objects carry authority; never scan plain text.

    None entities is an authoritative empty list on a native Message. Missing
    attributes or malformed ranges are incomplete, so group filtering fails closed.
    """
    text = getattr(message, "message", None) or ""
    value = {"version": 1, "source": "telegram_native_entities", "complete": True,
             "textField": "text", "coordinateSystem": "utf16", "entities": []}
    if not hasattr(message, "entities"):
        return {**value, "complete": False, "errorCode": "native_entities_unavailable"}
    encoded = text.encode("utf-16-le")
    for entity in message.entities or []:
        kind = type(entity).__name__
        if kind not in ("MessageEntityMention", "MessageEntityMentionName"):
            if "Mention" in kind:
                value.update(complete=False, errorCode="unsupported_mention_entity")
            continue
        try:
            offset, length = entity.offset, entity.length
            if type(offset) is not int or type(length) is not int or offset < 0 or length <= 0 or (offset+length)*2 > len(encoded):
                raise ValueError("range")
            span = encoded[offset*2:(offset+length)*2].decode("utf-16-le")
            username = None
            recipient = None
            if kind == "MessageEntityMentionName":
                recipient = str(entity.user_id)
                if not recipient.isdigit(): raise ValueError("recipient")
            else:
                import re
                if not re.fullmatch(r"@[A-Za-z0-9_]{1,32}", span): raise ValueError("username")
                username = span[1:]
            if len(value["entities"]) >= 100:
                value.update(complete=False, errorCode="mention_entity_limit")
                continue
            value["entities"].append({"nativeType": kind, "offset": offset, "length": length,
                                      "recipientUserId": recipient, "username": username})
        except (ValueError, AttributeError, UnicodeError):
            value.update(complete=False, errorCode="mention_range_or_target_invalid")
    return value


def normalise(message, chat_id):
    """Keep native IDs/topic evidence; never infer a forum root from a title."""
    # Telegram RichMessage stores visible content in blocks while `message` is
    # empty. Reuse the bridge owner's safe decoder, also used by legacy reads;
    # never serialize the native object or its media/access credentials.
    rich = getattr(message, "rich_message", None)
    rich_payload = {}
    text = message.message or ""
    if rich is not None:
        from telegram_mcp.rich_messages import message_text, rich_fields
        text = message_text(message)
        fields = rich_fields(message)
        rich_payload = {"richMessage": fields["rich_message"],
                        "contentComplete": not fields["rich_message"]["part"]}
    reply = getattr(message, "reply_to", None)
    root = getattr(reply, "reply_to_top_id", None)
    if root is None and getattr(reply, "forum_topic", False):
        root = getattr(reply, "reply_to_msg_id", None)
    file = getattr(message, "file", None)
    mime = getattr(file, "mime_type", None)
    kind = "audio" if mime and mime.startswith("audio/") else "video" if mime and mime.startswith("video/") else "image" if mime and mime.startswith("image/") else "document"
    media = getattr(message, "media", None)
    attachments = []
    if media is not None and "WebPage" not in type(media).__name__:
        attachments = [{"id": "message:" + str(message.id), "kind": kind,
                        "filename": getattr(file, "name", None), "mimeType": mime,
                        "size": getattr(file, "size", None)}]
    if attachments and kind == "video":
        fields = {"durationSeconds":getattr(file,"duration",None),"width":getattr(file,"width",None),"height":getattr(file,"height",None)}
        attachments[0]["video"] = {k:v for k,v in fields.items() if isinstance(v,(int,float)) and v>0}
    value = {"id": str(message.id), "conversationId": str(chat_id), "kind": "message",
             "direction": "outbound" if message.out else "inbound", "isSelf": bool(message.out),
             "senderId": str(message.sender_id) if message.sender_id is not None else None,
             "at": message.date.isoformat(), "text": text,
             "replyTo": str(reply.reply_to_msg_id) if reply and reply.reply_to_msg_id else None,
             "replyToKnown": True, "attachments": attachments}
    if root is not None:
        value["topicId"] = str(root)
    sender = getattr(message, "sender", None)
    if sender is not None and str(getattr(sender, "id", "")) == value["senderId"]:
        name = " ".join(x for x in [getattr(sender, "first_name", None), getattr(sender, "last_name", None)] if x) or getattr(sender, "title", None) or getattr(sender, "username", None)
        if name:
            value["authorLabel"] = name[:500]
    value["mentionEvidence"] = mention_evidence(message)
    if rich is not None:
        # Rich block mentions do not share ordinary message-entity offsets.
        # In particular, a rich-only group message cannot prove no mention.
        value["mentionEvidence"].update(complete=False, entities=[],
                                       errorCode="rich_text_entities_unavailable")
        value.update(rich_payload)
    edited = getattr(message, "edit_date", None)
    if edited:
        value["editedAt"] = edited.isoformat()
    return value


class Forwarder:
    """Session-free outbox; attach/remove handlers on a borrowed existing client."""
    def __init__(self, config):
        self.config = config
        self.chats = {str(x) for x in config["chatIds"]}
        if not self.chats or any(not x.lstrip("-").isdigit() for x in self.chats):
            raise ValueError("native_chat_allowlist_required")
        filename = Path(config["store"])
        filename.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.db = sqlite3.connect(filename)
        os.chmod(filename, 0o600)
        self.db.executescript("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,body TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS sources(identity TEXT PRIMARY KEY,body TEXT NOT NULL);")
        self.wake = asyncio.Event()
        self.task = None
        self.handlers = []
        self.account_id = None

    def record(self, body):
        if body["conversationId"] not in self.chats:
            return False
        encoded = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        event_id = hashlib.sha256(encoded.encode()).hexdigest()
        payload = json.dumps({"providerEventId": event_id, "message": body,
                              "accountSelfId": self.account_id,
                              "producer": {"captureKind": "live_delete" if body.get("deletedAt") else "live_edit" if body.get("editedAt") else "live_create", "capturedAt": datetime.now(timezone.utc).isoformat()}}, ensure_ascii=False)
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO outbox(id,body) VALUES(?,?)", (event_id, payload))
            self.db.execute("INSERT OR REPLACE INTO sources VALUES(?,?)", (json.dumps([body["conversationId"], body["id"]]), encoded))
        self.wake.set()
        return True

    async def start(self, client, events=None):
        if events is None:
            from telethon import events
        me = await client.get_me()
        if self.config.get("expectedSelfId") and str(me.id) != str(self.config["expectedSelfId"]):
            raise ValueError("native_account_mismatch")
        self.account_id = str(me.id)
        # General has no top-reply header. Prove the chat is a forum once using
        # the existing client before assigning Telegram's canonical General ID.
        forums = set()
        for chat in self.chats:
            entity = await client.get_entity(int(chat))
            if getattr(entity, "forum", False):
                forums.add(chat)
        async def incoming(event):
            if event.chat_id is not None:
                body = normalise(event.message, event.chat_id)
                if str(event.chat_id) in forums and "topicId" not in body:
                    body["topicId"] = "1"
                self.record(body)
        async def deleted(event):
            # Channel deletions carry a peer. Peer-less updates cannot be routed
            # safely, so provider history/gap recovery remains explicit.
            if event.chat_id is None or str(event.chat_id) not in self.chats:
                return
            for mid in event.deleted_ids:
                row = self.db.execute("SELECT body FROM sources WHERE identity=?", (json.dumps([str(event.chat_id), str(mid)]),)).fetchone()
                if row:
                    body = json.loads(row[0])
                    body.setdefault("deletedAt", datetime.now(timezone.utc).isoformat())
                    self.record(body)
        for callback, builder in [(incoming, events.NewMessage), (incoming, events.MessageEdited), (deleted, events.MessageDeleted)]:
            selector = builder(chats=[int(x) for x in self.chats])
            client.add_event_handler(callback, selector)
            self.handlers.append((client, callback, selector))
        self.task = asyncio.create_task(self.pump())
        return self

    def send(self, payload):
        credential = Path(self.config["credentialFile"])
        if credential.stat().st_mode & 0o077:
            raise ValueError("native_credential_permissions")
        saved = json.loads(credential.read_text())
        # Destination is fixed loopback; credentials cannot become a callback URL.
        port = int(self.config.get("hubPort", 8792))
        if not 1024 <= port <= 65535:
            raise ValueError("native_port_invalid")
        url = f"http://127.0.0.1:{port}/api/v1/ingest/{self.config['connectionId']}"
        req = urllib.request.Request(url, data=payload.encode(), headers={"Authorization": "Bearer " + saved["token"], "Content-Type": "application/json"})
        # Reject redirects before they could forward a private token.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        with urllib.request.build_opener(NoRedirect).open(req, timeout=10) as response:
            result = json.load(response)
            if result.get("status") != "committed":
                raise ValueError("native_receipt_unconfirmed")

    async def pump(self):
        backoff = 1
        while True:
            self.wake.clear()
            row = self.db.execute("SELECT id,body FROM outbox WHERE done=0 ORDER BY rowid LIMIT 1").fetchone()
            if row is None:
                await self.wake.wait()
                continue
            try:
                await asyncio.to_thread(self.send, row[1])
                with self.db:
                    self.db.execute("UPDATE outbox SET done=1 WHERE id=?", (row[0],))
                backoff = 1
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)

    async def close(self):
        for client, callback, selector in self.handlers:
            client.remove_event_handler(callback, selector)
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        self.db.close()


async def install_existing(clients, config_path):
    """Called by the bridge lifecycle only when an operator explicitly opts in."""
    path = Path(config_path)
    if path.stat().st_mode & 0o077:
        raise ValueError("native_config_permissions")
    config = json.loads(path.read_text())
    if not config.get("enabled", False):
        return None
    client = clients.get(config["account"])
    if client is None:
        raise ValueError("native_account_unknown")
    global _active_forwarder
    _active_forwarder = await Forwarder(config).start(client)
    return _active_forwarder


def register_tools(runtime):
    """Read forum history through the already authenticated, pinned bridge client.

    Telegram's GetRepliesRequest selects an exact forum root. This is explicit
    provider refresh, not polling or session ownership in Hub.
    """
    @runtime.mcp.tool()
    async def hub_topic_history(chat_id: int, topic_id: int, limit: int = 100,
                                offset_id: int = 0, account: str = None) -> str:
        from telethon.tl.functions.messages import GetRepliesRequest
        if not 1 <= limit <= 100 or topic_id <= 0 or offset_id < 0:
            raise ValueError("topic_request_invalid")
        client = runtime.get_client(account)
        entity = await runtime.resolve_entity(chat_id, client)
        if not getattr(entity, "forum", False):
            raise ValueError("topics_unsupported")
        result = await client(GetRepliesRequest(peer=entity, msg_id=topic_id,
                              offset_id=offset_id, offset_date=None, add_offset=0,
                              limit=limit, max_id=0, min_id=0, hash=0))
        rows = []
        for native in result.messages:
            if getattr(native, "date", None) is None:
                continue
            row = normalise(native, chat_id)
            # Returned user entities already belong to this RPC; never fetch per message.
            sender = next((u for u in result.users if u.id == native.sender_id), None)
            if sender:
                name = " ".join(x for x in [getattr(sender,"first_name",None),getattr(sender,"last_name",None)] if x) or getattr(sender,"username",None)
                if name: row["authorLabel"] = name[:500]
            row["topicId"] = str(topic_id)
            rows.append(row)
        return json.dumps({"items": rows,
                           "next": str(rows[-1]["id"]) if len(rows) == limit else None,
                           "complete": len(rows) < limit}, ensure_ascii=False)


    @runtime.mcp.tool()
    async def hub_video_thumbnail(chat_id: int, message_id: int, account: str = None) -> str:
        """Download only an explicit native thumb on the borrowed client.

        Missing thumbnails never fall back to original video download. No new
        login/session or entity discovery beyond this exact authorized source.
        """
        import base64
        client = runtime.get_client(account)
        entity = await runtime.resolve_entity(chat_id, client)
        message = await client.get_messages(entity, ids=message_id)
        document = getattr(message, "document", None)
        attrs = getattr(document, "attributes", [])
        video_attr = next((a for a in attrs if type(a).__name__ == "DocumentAttributeVideo"), None)
        if video_attr is None:
            return json.dumps({"status":"unavailable","video":{}})
        video = {"durationSeconds":float(video_attr.duration),"width":video_attr.w,"height":video_attr.h}
        thumbs = [t for t in getattr(document,"thumbs",[]) if getattr(t,"w",0)>0 and getattr(t,"h",0)>0]
        if not thumbs: return json.dumps({"status":"unavailable","video":video})
        thumb = max(thumbs,key=lambda t:t.w*t.h)
        if getattr(thumb,"size",0)>2*1024*1024: return json.dumps({"status":"unavailable","video":video})
        data = await client.download_media(message,file=bytes,thumb=thumb)
        if not data or len(data)>2*1024*1024: return json.dumps({"status":"unavailable","video":video})
        return json.dumps({"status":"ready","base64":base64.b64encode(data).decode(),
                           "mimeType":"image/jpeg","width":thumb.w,"height":thumb.h,"video":video})

    @runtime.mcp.tool()
    async def hub_native_identity(account: str = None) -> str:
        """Read authoritative self identity; no profile/contact/name lookup."""
        client = runtime.get_client(account)
        me = await client.get_me()
        account_label = next((label for label, cl in runtime.clients.items() if cl is client), account)
        return json.dumps({"account":account_label,"self": {"id": str(me.id), "isSelf": True,
                           "username": getattr(me,"username",None), "verified": True,
                           "evidence": "telegram_get_me", "verifiedAt": datetime.now(timezone.utc).isoformat()}})

    @runtime.mcp.tool()
    async def hub_native_history(chat_id: int, limit: int = 100, offset_id: int = 0,
                                 account: str = None) -> str:
        """Raw read preserves entities and full text on the borrowed client."""
        if not 1 <= limit <= 100 or offset_id < 0: raise ValueError("native_history_input")
        client = runtime.get_client(account)
        entity = await runtime.resolve_entity(chat_id, client)
        messages = await client.get_messages(entity, limit=limit, offset_id=offset_id)
        rows = [normalise(m,chat_id) for m in messages if getattr(m,"date",None)]
        return json.dumps({"items":rows,"next":str(rows[-1]["id"]) if len(rows)==limit else None,
                           "complete":len(rows)<limit},ensure_ascii=False)

    @runtime.mcp.tool()
    async def hub_native_message(chat_id: int, message_id: int, account: str = None) -> str:
        """Fetch one exact source, retaining native mention completeness."""
        client = runtime.get_client(account)
        entity = await runtime.resolve_entity(chat_id, client)
        native = await client.get_messages(entity, ids=message_id)
        return json.dumps({"message":normalise(native,chat_id) if native and getattr(native,"date",None) else None},ensure_ascii=False)

    @runtime.mcp.tool()
    async def hub_native_route_identity(chat_id: str, account: str = None) -> str:
        """Resolve an owner-specified peer, returning identity only, never chat text."""
        client=runtime.get_client(account)
        selector=int(chat_id) if chat_id.lstrip('-').isdigit() else chat_id
        entity=await runtime.resolve_entity(selector,client)
        from telethon import utils
        return json.dumps({"id":str(utils.get_peer_id(entity)),"username":getattr(entity,"username",None),
                           "forum":bool(getattr(entity,"forum",False))})


    @runtime.mcp.tool()
    async def hub_native_status() -> str:
        """Local hook diagnostics, not proof of actual provider delivery latency."""
        f=_active_forwarder
        if f is None: return json.dumps({"enabled":False,"registeredHandlers":0})
        pending=f.db.execute("SELECT COUNT(*) FROM outbox WHERE done=0").fetchone()[0]
        receipts=f.db.execute("SELECT COUNT(*) FROM outbox WHERE done=1").fetchone()[0]
        return json.dumps({"enabled":True,"registeredHandlers":len(f.handlers),
                           "selectedChatCount":len(f.chats),"accountSelfId":f.account_id,
                           "pendingOutbox":pending,"forwardedReceipts":receipts})

    @runtime.mcp.tool()
    async def hub_work_marker(chat_id: int, message_id: int, status: str,
                              apply: bool = False, expected_reactions: list[str] = None,
                              account: str = None) -> str:
        """Exact-message CAS on this session's reactions, never other's reactions.

        Hub persists the intent and grants before calling. A named green-check
        custom emoji is reused from the existing bridge. No permission/premium
        bypass, guessed fallback or automatic retry after a lost RPC response.
        """
        from telethon import functions
        from telethon.tl.types import ReactionEmoji, ReactionCustomEmoji
        targets = {'viewed': '👀', 'in_progress': '👨‍💻', 'completed': 'custom:5206607081334906820', 'question': '🤔'}
        if status not in targets or message_id <= 0:
            raise ValueError('marker_input_invalid')
        client = runtime.get_client(account)
        peer = await runtime.resolve_entity(chat_id, client)
        message = await client.get_messages(peer, ids=message_id)
        if not message:
            return json.dumps({'state': 'failed', 'reason': 'marker_message_unavailable'})
        value = getattr(message, 'reactions', None)
        if value and getattr(value, 'min', False):
            return json.dumps({'state': 'failed', 'reason': 'marker_snapshot_incomplete'})
        actual = []
        for item in getattr(value, 'results', []) or []:
            if getattr(item, 'chosen_order', None) is None:
                continue
            r = item.reaction
            if isinstance(r, ReactionCustomEmoji): actual.append(f'custom:{r.document_id}')
            elif isinstance(r, ReactionEmoji): actual.append(r.emoticon)
            else: return json.dumps({'state': 'failed', 'reason': 'marker_reaction_unsupported'})
        target = targets[status]
        response = {'state': 'applied' if target in actual else 'unknown', 'reactions': sorted(actual),
                    'nativeReaction': target, 'emoji': '✅' if status == 'completed' else target,
                    'confirmation': 'native_own_reaction_snapshot' if target in actual else 'unconfirmed'}
        if not apply:
            return json.dumps(response)
        if sorted(actual) != sorted(expected_reactions or []):
            return json.dumps({**response, 'state': 'failed', 'reason': 'marker_snapshot_conflict'})
        # Only replace our work markers, keeping unrelated chosen emoji. Standard
        # check is recognised for migration; Telegram never falls back to it here.
        work = set(targets.values()) | {'✅'}
        desired = [r for r in actual if r not in work] + [target]
        objects = [ReactionCustomEmoji(document_id=int(r[7:])) if r.startswith('custom:')
                   else ReactionEmoji(emoticon=r) for r in desired]
        try:
            await client(functions.messages.SendReactionRequest(peer=peer, msg_id=message_id, reaction=objects))
        except Exception as e:
            if type(e).__name__ in ('ReactionInvalidError', 'CustomEmojiInvalidError', 'ReactionsTooManyError', 'ChatWriteForbiddenError', 'PremiumAccountRequiredError', 'MessageIdInvalidError'):
                return json.dumps({'state': 'failed', 'reason': 'marker_provider_rejected', 'providerCode': type(e).__name__})
            raise  # Hub keeps uncertain transport outcomes unknown; no second write.
        confirmed = await client.get_messages(peer, ids=message_id)
        chosen = []
        reactions = getattr(confirmed, 'reactions', None)
        if confirmed and not getattr(reactions, 'min', False):
            for item in getattr(reactions, 'results', []) or []:
                if getattr(item, 'chosen_order', None) is not None:
                    r = item.reaction
                    chosen.append(f'custom:{r.document_id}' if isinstance(r, ReactionCustomEmoji) else getattr(r, 'emoticon', 'unknown'))
        return json.dumps({**response, 'state': 'applied' if sorted(chosen) == sorted(desired) else 'unknown',
                           'reactions': sorted(chosen), 'confirmation': 'native_own_reaction_snapshot' if sorted(chosen) == sorted(desired) else 'unconfirmed'})

    @runtime.mcp.tool()
    async def hub_marker_capabilities(account: str = None) -> str:
        """Read-only check of the pinned green-check document, not permission to write."""
        from telethon import functions
        client = runtime.get_client(account)
        docs = await client(functions.messages.GetCustomEmojiDocumentsRequest(document_id=[5206607081334906820]))
        alts = [getattr(a, 'alt', None) for d in docs for a in d.attributes if type(a).__name__ == 'DocumentAttributeCustomEmoji']
        return json.dumps({'greenCheckDocumentId': '5206607081334906820', 'greenCheckAlt': alts[0] if alts else None,
                           'statuses': ['viewed', 'in_progress', 'completed', 'question']})
