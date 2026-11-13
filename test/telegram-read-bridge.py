"""Read-address tests use real TL types but fake clients; no login or network."""
import unittest
from pathlib import Path
from types import SimpleNamespace
from telethon import types, functions

# Engine-only import keeps runtime decorators/account/session initialization out.
engine = {}
exec(compile((Path(__file__).parents[1] / 'bridges/telegram-hub-read.py').read_text().split('from telegram_mcp.runtime import')[0], 'telegram-hub-read.py', 'exec'), engine)


def user(id, name):
    return types.User(id=id, first_name=name)


def channel(id, title, broadcast=True):
    return types.Channel(id=id, title=title, photo=types.ChatPhotoEmpty(), date=None, broadcast=broadcast, megagroup=not broadcast, username='alarm_channel' if broadcast else 'team_group')


class ReadTests(unittest.IsolatedAsyncioTestCase):
    async def test_catalog_merges_contacts_and_typed_dialogs_before_filtering(self):
        # A contact and channel with the same name must both survive; duplicate
        # saved contact/dialog identities must not create false ambiguity.
        class Client:
            async def get_dialogs(self, limit):
                return [SimpleNamespace(entity=channel(12, 'Alarm')), SimpleNamespace(entity=user(4, 'Alarm')), SimpleNamespace(entity=channel(13, 'Team', False))]

            async def __call__(self, request):
                assert isinstance(request, functions.contacts.GetContactsRequest)
                return SimpleNamespace(users=[user(4, 'Alarm'), user(8, 'Saved only')])

        first = await engine['read_catalog'](Client(), limit=1, query='Alarm')
        self.assertEqual(first['items'][0]['id'], '-1000000000012')
        self.assertEqual(first['items'][0]['kind'], 'channel')
        self.assertIsNotNone(first['next'])
        second = await engine['read_catalog'](Client(), offset=1, limit=1, query='Alarm')
        self.assertEqual(second['items'][0]['kind'], 'direct')
        self.assertTrue(second['complete'])
        self.assertIsNone(second['next'])
        group = await engine['read_catalog'](Client(), query='Team')
        self.assertEqual(group['items'][0]['kind'], 'group')

    async def test_capped_catalog_miss_is_incomplete_and_exact_username_uses_rpc(self):
        # A cap hit cannot establish absence; username lookup has no dialog cap.
        class Client:
            async def get_dialogs(self, limit):
                return [SimpleNamespace(entity=user(i + 1, 'Other')) for i in range(5001)]

            async def __call__(self, request):
                if isinstance(request, functions.contacts.ResolveUsernameRequest):
                    return SimpleNamespace(peer=types.PeerChannel(12), chats=[channel(12, 'Alarm')], users=[])
                return SimpleNamespace(users=[])

        miss = await engine['read_catalog'](Client(), query='Absent')
        self.assertEqual(miss['items'], [])
        self.assertFalse(miss['complete'])
        self.assertTrue(miss['coverage']['truncated'])
        exact = await engine['resolve_read'](Client(), 'alarm_channel')
        self.assertEqual(exact['item']['id'], '-1000000000012')

    async def test_only_known_native_refusals_are_access_denials(self):
        # Unknown provider failures stay provider failures and never include raw
        # exception text, even if a private phone/path appears in that text.
        for name, code in [('UsernameNotOccupiedError', 'conversation_not_found'), ('UsernameInvalidError', 'conversation_format_invalid'), ('ChannelPrivateError', 'conversation_access_denied'), ('TimeoutError', 'telegram_read_provider_failed')]:
            class Client:
                async def __call__(self, request):
                    raise type(name, (Exception,), {})('private-placeholder')
            result = await engine['resolve_read'](Client(), 'alarm_channel')
            self.assertEqual(result, {'error': code})


if __name__ == '__main__':
    unittest.main()
