"""Fake MTProto tests of the shipped bridge engine, without importing runtime/login.

Real Telethon TL classes validate method/rights choices. All RPCs and entities
come from an in-memory fake; no session, secrets, client account or network exists.
"""
import asyncio
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

source = Path('bridges/telegram-hub-forum.py').read_text().split('# Registration imports')[0]
ns = {}
exec(compile(source, '<forum-engine>', 'exec'), ns)
Engine, types, functions, errors = (ns[k] for k in ('ForumEngine', 'types', 'functions', 'errors'))
OWNER, BOTID = 100000001, 777
now = datetime.now(timezone.utc)
key, marker = '12345678-1234-1234-1234-123456789abc', 'WZ-Hub:' + 'a' * 48


class Fake:
    def __init__(self):
        self.me = types.User(OWNER, is_self=True, bot=False)
        self.bot = types.User(BOTID, bot=True, username='example_forum_bot')
        self.channel = None
        self.about = None
        self.invited = False
        self.admin = False
        self.hidden = True
        self.closed = True
        self.writes = []
        self.failure = None
        self.lost_create = False
        self.duplicates = []

    async def get_me(self):
        return self.me

    async def get_entity(self, value):
        return self.bot if value == 'example_forum_bot' else self.channel

    async def iter_dialogs(self, **kwargs):
        for entity in ([self.channel] if self.channel else []) + self.duplicates:
            yield SimpleNamespace(entity=entity)

    async def __call__(self, request):
        if isinstance(request, functions.channels.GetFullChannelRequest):
            return SimpleNamespace(full_chat=SimpleNamespace(about=self.about, linked_chat_id=None))
        if isinstance(request, functions.channels.GetParticipantsRequest):
            owner = types.ChannelParticipantCreator(OWNER, types.ChatAdminRights())
            bot = types.ChannelParticipantAdmin(BOTID, OWNER, now, types.ChatAdminRights(manage_topics=True, other=True)) if self.admin else types.ChannelParticipant(BOTID, now)
            participants = [owner] + ([bot] if self.invited else [])
            return SimpleNamespace(count=len(participants), participants=participants)
        if isinstance(request, functions.messages.GetForumTopicsByIDRequest):
            topic = types.ForumTopic(1, now, types.PeerChannel(321), 'General', 0, 1, 0, 0, 0, 0, 0, 0, types.PeerUser(OWNER), types.PeerNotifySettings(), hidden=self.hidden, closed=self.closed)
            return SimpleNamespace(topics=[topic])
        raise AssertionError('unexpected read ' + type(request).__name__)

    async def write(self, request):
        self.writes.append(type(request).__name__)
        if self.failure == 'invite' and isinstance(request, functions.channels.InviteToChannelRequest):
            raise errors.UserPrivacyRestrictedError(request)
        if self.failure == 'admin' and isinstance(request, functions.channels.EditAdminRequest):
            raise errors.ChatAdminRequiredError(request)
        if isinstance(request, functions.channels.CreateChannelRequest):
            assert request.megagroup and request.forum and request.about == marker
            assert self.channel is None, 'a duplicate group was created'
            self.channel = types.Channel(321, request.title, types.ChatPhotoEmpty(), now, creator=True, megagroup=True, forum=True)
            self.about = request.about
            if self.lost_create:
                raise ConnectionError('created but lost response')
            return SimpleNamespace(chats=[self.channel])
        if isinstance(request, functions.channels.InviteToChannelRequest):
            assert request.users == [self.bot]
            self.invited = True
        elif isinstance(request, functions.channels.EditAdminRequest):
            assert [k for k, v in request.admin_rights.to_dict().items() if v is True] == ['manage_topics']
            self.admin = True
        elif isinstance(request, functions.messages.EditForumTopicRequest):
            assert request.topic_id == 1
            if request.hidden is False:
                self.hidden = False
            if request.closed is False:
                self.closed = False
        return SimpleNamespace()


def engine(fake, root):
    return Engine(fake, root, write=fake.write, policy={"ownerId": str(OWNER), "botUsername": "example_forum_bot"})


async def step(instance, action, uncertain=False):
    return await instance.step(key, marker, 'WorkZone · Внутренний тест', 'example_forum_bot', str(OWNER), action, uncertain)


async def main():
    # Missing independent bridge policy and a mismatched operator owner must
    # fail before any provider write, even if the request names a valid account.
    with tempfile.TemporaryDirectory() as root:
        fake = Fake()
        missing = Engine(fake, root, write=fake.write, policy={})
        assert (await step(missing, 'create'))['diagnostic']['code'] == 'group_policy_violation'
        wrong = Engine(fake, root, write=fake.write, policy={"ownerId": "100000099", "botUsername": "example_forum_bot"})
        assert (await wrong.step(key, marker, 'WorkZone · fake', 'example_forum_bot', '100000099', 'create'))['diagnostic']['code'] == 'group_owner_mismatch'
        assert fake.writes == []
    # Create, invite only the approved bot, grant only manage_topics, and expose General.
    with tempfile.TemporaryDirectory() as root:
        fake = Fake()
        instance = engine(fake, root)
        for action in ['create', 'add_bot', 'promote_bot', 'general_unhide', 'general_open']:
            result = await step(instance, action)
            assert result['status'] == 'ok', result
        assert result['verification']['ready'] and result['conversationId'] == '-1000000000321'
        assert result['verification']['participantIds'] == ['100000001', '777']
        before = list(fake.writes)
        assert (await step(engine(fake, root), 'create'))['verification']['ready']
        assert fake.writes == before

    # After a lost creation response, a new engine recovers the exact random marker.
    with tempfile.TemporaryDirectory() as root:
        fake = Fake()
        fake.lost_create = True
        assert (await step(engine(fake, root), 'create'))['status'] == 'unknown'
        fake.lost_create = False
        observed = await step(engine(fake, root), 'inspect', True)
        assert observed['conversationId'] == '-1000000000321'
        assert fake.writes == ['CreateChannelRequest']

    # No creation evidence after restart remains unknown, including matching title alone.
    with tempfile.TemporaryDirectory() as root:
        fake = Fake()
        fake.channel = types.Channel(444, 'WorkZone · Внутренний тест', types.ChatPhotoEmpty(), now, creator=True, megagroup=True, forum=True)
        fake.about = 'same title, unrelated group'
        assert (await step(engine(fake, root), 'inspect', True))['status'] == 'unknown'
        assert (await step(engine(fake, root), 'create'))['status'] == 'unknown'
        assert not fake.writes

    # An explicit invitation/admin refusal preserves the created group for resume.
    for failure, action in [('invite', 'add_bot'), ('admin', 'promote_bot')]:
        with tempfile.TemporaryDirectory() as root:
            fake = Fake()
            instance = engine(fake, root)
            await step(instance, 'create')
            if action == 'promote_bot':
                await step(instance, 'add_bot')
            fake.failure = failure
            rejected = await step(instance, action)
            assert rejected['status'] == 'blocked' and rejected['conversationId'] == '-1000000000321', rejected
            fake.failure = None
            assert (await step(engine(fake, root), action))['status'] == 'ok'
            assert fake.writes.count('CreateChannelRequest') == 1

    # OS locks refuse a concurrent creator even across independent engine instances.
    with tempfile.TemporaryDirectory() as root:
        fake = Fake()
        gate = asyncio.Event()
        started = asyncio.Event()
        async def slow_write(request):
            started.set()
            await gate.wait()
            return await fake.write(request)
        first_engine = Engine(fake, root, write=slow_write, policy={"ownerId": str(OWNER), "botUsername": "example_forum_bot"})
        first = asyncio.create_task(step(first_engine, 'create'))
        await asyncio.wait_for(started.wait(), 2)
        assert (await step(engine(fake, root), 'create'))['diagnostic']['code'] == 'group_operation_in_progress'
        gate.set()
        assert (await first)['status'] == 'ok'
        assert fake.writes.count('CreateChannelRequest') == 1

    # The no-retry view has zero application retries and never edits the shared client.
    client = SimpleNamespace(_request_retries=5, _sender=object(), session=object())
    view = ns['NoRequestRetries'](client)
    assert view._request_retries == 0 and client._request_retries == 5
    assert view.session is client.session and view._sender is client._sender
    # Exercise the installed Telethon call loop: a server error after a create
    # attempt must result in exactly one sender.send, regardless of shared retries.
    class Sender:
        sends = 0
        def send(self, request, **kwargs):
            self.sends += 1
            future = asyncio.get_running_loop().create_future()
            future.set_exception(errors.ServerError(request, 'synthetic', 500))
            return future
    class Log:
        def __getitem__(self, key):
            return SimpleNamespace(warning=lambda *args: None, info=lambda *args: None)
    sender = Sender()
    shared = SimpleNamespace(_request_retries=5, _sender=sender, _loop=None,
                             _flood_waited_requests={}, _no_updates=False, _log=Log(),
                             session=SimpleNamespace(process_entities=lambda result: None))
    request = functions.channels.CreateChannelRequest('WorkZone · fake', marker, megagroup=True, forum=True)
    try:
        with tempfile.TemporaryDirectory() as root:
            await Engine(shared, root)._write(request)
        raise AssertionError('server rejection should propagate')
    except errors.ServerError:
        assert sender.sends == 1 and shared._request_retries == 5
    print('Telegram forum bridge: 11 fake scenarios passed')

asyncio.run(main())
