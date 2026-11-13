"""Structured read-only addressing on the existing authenticated Telegram client.

No joins, invitations, login or client construction. A bounded catalog includes
saved contacts and every dialog type; truncation is evidence, never absence.
"""
import json
from telethon import functions, types, utils


def public_peer(entity):
    """Use Telegram's marked ID, not bare Channel.id which aliases user IDs."""
    return {"id": str(utils.get_peer_id(entity)),
            "title": getattr(entity, "title", None) or " ".join(filter(None, [getattr(entity, "first_name", None), getattr(entity, "last_name", None)])) or str(entity.id),
            "username": getattr(entity, "username", None),
            "kind": "channel" if isinstance(entity, types.Channel) and entity.broadcast else "group" if isinstance(entity, (types.Channel, types.Chat)) else "direct",
            "canSend": not isinstance(entity, types.Channel) or not entity.broadcast or bool(getattr(entity, "creator", False) or getattr(getattr(entity, "admin_rights", None), "post_messages", False))}


def read_error(error):
    """Publish categories only; never expose phone/session or RPC exception bodies."""
    name = type(error).__name__
    if name in {"UsernameInvalidError"}:
        code = "conversation_format_invalid"
    elif name in {"UsernameNotOccupiedError"}:
        code = "conversation_not_found"
    elif name in {"ChannelPrivateError", "ChatForbiddenError", "UserBannedInChannelError", "ChatAdminRequiredError", "ChannelPublicGroupNaError"}:
        code = "conversation_access_denied"
    else:
        code = "telegram_read_provider_failed"
    return {"error": code}


async def resolve_read(client, username):
    """Resolve exact usernames over Telegram RPC, bypassing stale name caches."""
    try:
        result = await client(functions.contacts.ResolveUsernameRequest(username=username))
        marked = utils.get_peer_id(result.peer)
        entity = next(e for e in [*result.chats, *result.users] if utils.get_peer_id(e) == marked)
        return {"item": public_peer(entity)}
    except Exception as error:
        return read_error(error)


async def read_catalog(client, offset=0, limit=100, query=""):
    """Merge every peer kind before filtering; page the resulting candidates.

    The cap bounds account enumeration. Each page rebuilds current metadata,
    so this is a live catalog, not an immutable snapshot. A cap hit stays explicit
    even on the last page. No public directory search or automatic joins occur.
    """
    if offset < 0 or not 1 <= limit <= 100:
        return {"error": "cursor_invalid"}
    try:
        dialogs = await client.get_dialogs(limit=5001)
        contacts = await client(functions.contacts.GetContactsRequest(hash=0))
        peers = {str(utils.get_peer_id(d.entity)): public_peer(d.entity) for d in dialogs[:5000]}
        for user in contacts.users:
            peers.setdefault(str(utils.get_peer_id(user)), public_peer(user))
        # Filter only AFTER enumerating all peer kinds, before result pagination.
        # A miss still retains truncated coverage; no contacts-only early return.
        needle = query.strip().casefold()
        rows = [p for p in peers.values() if not needle or needle in f"{p['title']} {p['id']} {p['username'] or ''}".casefold()]
        more = offset + limit < len(rows)
        truncated = len(dialogs) > 5000
        return {"items": rows[offset:offset + limit], "next": str(offset + limit) if more else None,
                "complete": not more and not truncated,
                "coverage": {"source": "telegram_dialogs_and_saved_contacts", "truncated": truncated,
                             "dialogLimit": 5000, "snapshot": False}}
    except Exception as error:
        return read_error(error)


# Registration borrows only the runtime-owned client; importing the engine in
# isolated tests stops before this boundary and never opens a Telegram session.
# readonly=False disables multi-account fanout: one Hub connection is one account,
# even though both tools themselves are read-only.
from telegram_mcp.runtime import mcp, with_account, get_client, ToolAnnotations


@mcp.tool(annotations=ToolAnnotations(title="Hub Read Resolve", readOnlyHint=True))
@with_account(readonly=False)
async def hub_read_resolve(username: str, account: str = None) -> str:
    """Exact username metadata for Hub read addressing, without joining."""
    return json.dumps(await resolve_read(get_client(account), username), ensure_ascii=False)


@mcp.tool(annotations=ToolAnnotations(title="Hub Read Catalog", readOnlyHint=True))
@with_account(readonly=False)
async def hub_read_catalog(offset: int = 0, limit: int = 100, query: str = "", account: str = None) -> str:
    """Bounded typed dialogs plus saved contacts; explicit continuation/coverage."""
    return json.dumps(await read_catalog(get_client(account), offset, limit, query), ensure_ascii=False)
