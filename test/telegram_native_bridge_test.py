"""Synthetic native bridge recovery; no Telegram client/login/network is created."""
import importlib.util
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location('updates', Path(__file__).parents[1] / 'bridges/telegram-hub-updates.py')
updates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updates)


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    def test_rich_only_outgoing_message_keeps_visible_text_and_partial_flag(self):
        # Plain text may be empty although Telegram renders a full RichMessage.
        # Borrow the owner's decoder for history/events and keep partial content
        # explicit, without treating flattened rich blocks as mention evidence.
        import sys
        from unittest.mock import patch
        rich=types.SimpleNamespace(part=False)
        native=types.SimpleNamespace(id=22,sender_id=10,out=True,
            date=datetime(2026,10,5,tzinfo=timezone.utc),message="",
            rich_message=rich,reply_to=None,media=None,file=None,edit_date=None,entities=[])
        decoder=types.ModuleType("telegram_mcp.rich_messages")
        decoder.message_text=lambda m:"Instructions\n1. Open https://example.org\n2. Continue"
        decoder.rich_fields=lambda m:{"rich_message":{"blocks":[{"_":"PageBlockParagraph","text":{"_":"TextPlain","text":"Instructions"}}],"part":m.rich_message.part,"rtl":False,"photo_count":0,"document_count":0}}
        with patch.dict(sys.modules,{"telegram_mcp.rich_messages":decoder}):
            full=updates.normalise(native,"521")
            self.assertEqual(full["text"],decoder.message_text(native))
            self.assertEqual(full["direction"],"outbound")
            self.assertTrue(full["contentComplete"])
            self.assertIn("richMessage",full)
            self.assertFalse(full["mentionEvidence"]["complete"])
            rich.part=True
            self.assertFalse(updates.normalise(native,"521")["contentComplete"])

    async def test_selected_topic_is_native_and_outbox_survives_restart(self):
        # Callback bodies retain exact native topic and emoji; replay uses one stable event ID.
        with tempfile.TemporaryDirectory() as root:
            cfg = {'chatIds': ['-100123'], 'store': str(Path(root) / 'outbox.sqlite')}
            forwarder = updates.Forwarder(cfg)
            forwarder.account_id = 'owner'
            native = types.SimpleNamespace(id=8, sender_id=12, out=False,
                     date=datetime(2026, 10, 2, tzinfo=timezone.utc), message='🙂 exact',
                     reply_to=types.SimpleNamespace(reply_to_top_id=7, reply_to_msg_id=8, forum_topic=True),
                     media=None, file=None, edit_date=None)
            body = updates.normalise(native, '-100123')
            self.assertEqual(body['topicId'], '7')
            self.assertEqual(body['replyTo'], '8')
            self.assertTrue(forwarder.record(body))
            captured_payload = forwarder.db.execute('SELECT body FROM outbox').fetchone()[0]
            self.assertTrue(forwarder.record(body))
            self.assertEqual(forwarder.db.execute('SELECT body FROM outbox').fetchone()[0], captured_payload)
            import json
            self.assertEqual(json.loads(captured_payload)['producer']['captureKind'], 'live_create')
            self.assertEqual(forwarder.db.execute('SELECT COUNT(*) FROM outbox').fetchone()[0], 1)
            self.assertFalse(forwarder.record({**body, 'conversationId': '-100999'}))
            await forwarder.close()
            restarted = updates.Forwarder(cfg)
            self.assertEqual(restarted.db.execute('SELECT COUNT(*) FROM outbox WHERE done=0').fetchone()[0], 1)
            await restarted.close()

    async def test_general_arrival_uses_verified_forum_and_three_borrowed_handlers(self):
        # Native General has no reply header; only a verified forum permits root1.
        with tempfile.TemporaryDirectory() as root:
            f = updates.Forwarder({'chatIds': ['-100123'], 'store': str(Path(root) / 'db'), 'expectedSelfId': 'owner'})
            handlers = []
            class Client:
                async def get_me(self): return types.SimpleNamespace(id='owner')
                async def get_entity(self, chat): return types.SimpleNamespace(forum=True)
                def add_event_handler(self, callback, selector): handlers.append((callback, selector))
                def remove_event_handler(self, *args): pass
            events = types.SimpleNamespace(NewMessage=lambda **kw:kw,MessageEdited=lambda **kw:kw,MessageDeleted=lambda **kw:kw)
            await f.start(Client(), events=events)
            self.assertEqual(len(handlers), 3)
            native = types.SimpleNamespace(id=9,sender_id=12,out=False,date=datetime(2026,10,2,tzinfo=timezone.utc),message='General 🙂',reply_to=None,media=None,file=None,edit_date=None)
            await handlers[0][0](types.SimpleNamespace(chat_id=-100123,message=native))
            import json
            payload = json.loads(f.db.execute('SELECT body FROM outbox').fetchone()[0])
            self.assertEqual(payload['message']['topicId'], '1')
            await f.close()

    async def test_native_mentions_utf16_named_username_empty_and_incomplete(self):
        # Native entities only, including astral coordinates and exact named ID.
        MentionName = type("MessageEntityMentionName", (), {})
        Mention = type("MessageEntityMention", (), {})
        named = MentionName(); named.offset=3; named.length=5; named.user_id=100000001
        m = types.SimpleNamespace(message="🙂 Owner",entities=[named])
        evidence=updates.mention_evidence(m)
        self.assertTrue(evidence["complete"])
        self.assertEqual(evidence["entities"][0]["recipientUserId"],"100000001")
        named.offset=1
        self.assertFalse(updates.mention_evidence(m)["complete"])
        native=Mention(); native.offset=3; native.length=6
        m=types.SimpleNamespace(message="🙂 @owner",entities=[native])
        self.assertEqual(updates.mention_evidence(m)["entities"][0]["username"],"owner")
        self.assertEqual(updates.mention_evidence(types.SimpleNamespace(message="@owner",entities=None))["entities"],[])
        self.assertFalse(updates.mention_evidence(types.SimpleNamespace(message="@owner"))["complete"])

    async def test_existing_client_account_mismatch_does_not_register_handlers(self):
        # A borrowed client is verified; no fallback login or switching account is allowed.
        with tempfile.TemporaryDirectory() as root:
            f = updates.Forwarder({'chatIds': ['1'], 'store': str(Path(root) / 'db'), 'expectedSelfId': 'owner'})
            class Client:
                async def get_me(self):
                    return types.SimpleNamespace(id='wrong')
                def add_event_handler(self, *args):
                    raise AssertionError('must not register')
            with self.assertRaisesRegex(ValueError, 'account_mismatch'):
                await f.start(Client(), events=object())
            await f.close()


    async def test_work_marker_preserves_unrelated_own_reaction_and_rejects_cas(self):
        # Real client/session/network never starts; native own chosen_order=0 is preserved.
        import sys
        from unittest.mock import patch
        class ReactionEmoji:
            def __init__(self, emoticon): self.emoticon = emoticon
        class ReactionCustomEmoji:
            def __init__(self, document_id): self.document_id = document_id
        methods = {}
        class MCP:
            def tool(self):
                def register(fn): methods[fn.__name__] = fn; return fn
                return register
        class Client:
            def __init__(self): self.reactions = [ReactionEmoji('❤️'), ReactionEmoji('👀')]; self.writes = 0
            async def get_messages(self, peer, ids):
                return types.SimpleNamespace(reactions=types.SimpleNamespace(min=False, results=[types.SimpleNamespace(chosen_order=0, reaction=r) for r in self.reactions]))
            async def __call__(self, req): self.reactions = req.reaction; self.writes += 1
        client = Client()
        async def resolve(chat, c): return chat
        runtime = types.SimpleNamespace(mcp=MCP(),get_client=lambda account: client,resolve_entity=resolve)
        updates.register_tools(runtime)
        telethon = types.ModuleType('telethon');telethon.functions = types.SimpleNamespace(messages=types.SimpleNamespace(SendReactionRequest=lambda **kw: types.SimpleNamespace(**kw)))
        tl = types.ModuleType('telethon.tl');native = types.ModuleType('telethon.tl.types');native.ReactionEmoji=ReactionEmoji;native.ReactionCustomEmoji=ReactionCustomEmoji
        import json
        with patch.dict(sys.modules, {'telethon':telethon,'telethon.tl':tl,'telethon.tl.types':native}):
            fn=methods['hub_work_marker'];before=json.loads(await fn(1,7,'completed'))
            bad=json.loads(await fn(1,7,'completed',True,[]));self.assertEqual(bad['state'],'failed');self.assertEqual(client.writes,0)
            result=json.loads(await fn(1,7,'completed',True,before['reactions']));self.assertEqual(result['state'],'applied');self.assertEqual(result['emoji'],'✅');self.assertIn('❤️',result['reactions']);self.assertNotIn('👀',result['reactions']);self.assertEqual(client.writes,1)

    async def test_video_thumbnail_uses_explicit_native_thumb_never_original(self):
        # Borrowed client only; missing thumbs must not call download_media at all.
        methods={}
        class MCP:
            def tool(self):
                def register(fn): methods[fn.__name__]=fn;return fn
                return register
        class DocumentAttributeVideo:
            duration=2;w=64;h=48
        thumb=types.SimpleNamespace(w=32,h=24,size=50)
        document=types.SimpleNamespace(attributes=[DocumentAttributeVideo()],thumbs=[thumb])
        class Client:
            calls=0
            async def get_messages(self,peer,ids): return types.SimpleNamespace(document=document)
            async def download_media(self,message,**kwargs):
                self.calls+=1
                self.assert_thumb=kwargs['thumb'] is thumb
                return b'synthetic preview'
        client=Client()
        async def resolve(chat,c): return chat
        updates.register_tools(types.SimpleNamespace(mcp=MCP(),get_client=lambda account:client,resolve_entity=resolve))
        import json
        r=json.loads(await methods['hub_video_thumbnail'](1,7));self.assertEqual(r['status'],'ready');self.assertTrue(client.assert_thumb);self.assertEqual(client.calls,1)
        document.thumbs=[]
        r=json.loads(await methods['hub_video_thumbnail'](1,7));self.assertEqual(r['status'],'unavailable');self.assertEqual(client.calls,1)

if __name__ == '__main__':
    unittest.main()
