"""Recovery regressions use fake clients/services; no Telegram or real secrets.

Run with Python stdlib unittest. HTTP cases exercise real local requests against
an isolated ephemeral UI, including the proxy-Origin failure seen in production.
"""
import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import datetime
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).parents[1] / 'scripts/telegram-recovery.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = Path(self.temp.name) / '.env'
        self.original = 'OTHER=preserved\nTELEGRAM_SESSION_STRING=old\n'
        self.env.write_text(self.original)
        self.env.chmod(0o600)
        self.calls = []

    def recovery(self, login, health=None):
        return m.Recovery('123', health or (lambda: {'available': True, 'configuredSelfMatches': True, 'self': {'id': '123'}}), login, self.calls.append, self.env)

    def test_success_installs_only_expected_owner_and_checks_hub(self):
        # Returning from login represents a disconnected fake temporary client.
        async def login(r):
            self.calls.append('temporary_disconnected')
            return '123', 'new-session'
        r = self.recovery(login)
        asyncio.run(r.run())
        self.assertEqual(self.calls, ['stop', 'temporary_disconnected', 'start'])
        self.assertEqual(self.env.read_text(), self.original.replace('old', 'new-session'))
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o600)
        self.assertEqual(r.snapshot()['status'], 'connected')
        self.assertNotIn('session', json.dumps(r.snapshot()))

    def test_other_account_never_replaces_env_and_restarts_old_bridge(self):
        async def login(r):
            return '999', 'other-session'
        r = self.recovery(login)
        asyncio.run(r.run())
        self.assertEqual(self.env.read_text(), self.original)
        self.assertEqual(self.calls, ['stop', 'start'])
        self.assertEqual(r.snapshot()['reason'], 'account_mismatch')

    def test_failed_qr_restores_service_and_does_not_expose_error_bodies(self):
        async def login(r):
            raise ValueError('secret-provider-body')
        r = self.recovery(login)
        asyncio.run(r.run())
        self.assertEqual(self.calls, ['stop', 'start'])
        self.assertEqual(self.env.read_text(), self.original)
        self.assertEqual(r.snapshot()['reason'], 'recovery_failed')
        self.assertNotIn('secret-provider-body', json.dumps(r.snapshot()))

    def test_concurrent_env_edit_is_preserved(self):
        async def login(r):
            self.env.write_text('changed-by-owner')
            return '123', 'new-session'
        r = self.recovery(login)
        asyncio.run(r.run())
        self.assertEqual(self.env.read_text(), 'changed-by-owner')
        self.assertEqual(r.snapshot()['reason'], 'credentials_changed')
        self.assertEqual(self.calls, ['stop', 'start'])

    def test_no_false_connected_and_no_automatic_login(self):
        async def forbidden(r):
            self.fail('a status check must not start login')
        r = self.recovery(forbidden, lambda: {'available': True, 'configuredSelfMatches': True, 'self': {'id': '999'}})
        r.check()
        self.assertEqual(r.snapshot()['status'], 'unavailable')
        self.assertEqual(self.calls, [])

    def test_busy_blocks_duplicate_start_password_and_health_overwrite(self):
        r = self.recovery(None)
        r.set('password')
        self.assertFalse(r.begin())
        self.assertTrue(r.password('Synthetic + & = пароль'))
        self.assertFalse(r.password('duplicate'))
        r.check()
        self.assertEqual(r.snapshot()['status'], 'password_checking')
        self.assertEqual(r.passwords.get_nowait(), 'Synthetic + & = пароль')

    def test_bounded_failure_reasons_stay_distinct(self):
        # Expired QR and Telegram password refusal are separate from form errors.
        for reason in ['qr_timeout', 'password_timeout', 'password_attempt_limit', 'flood_wait']:
            async def login(r):
                raise RuntimeError(reason)
            r = self.recovery(login)
            asyncio.run(r.run())
            self.assertEqual(r.snapshot()['reason'], reason)
            self.assertEqual(self.env.read_text(), self.original)


    def test_auto_opens_once_only_after_qr_ready_and_survives_monitor_restart(self):
        # A revoked invocation gets one durable attempt; QR refreshes and a
        # recovery-service restart must not keep interrupting the desktop.
        r = self.recovery(None)
        marker = Path(self.temp.name) / 'attempt'
        starts, opened = [], []
        def begin():
            starts.append('start')
            r.set('starting')
            return True
        r.begin = begin
        auto = m.AutoRecovery(r, marker, lambda: 'incident-one', lambda: opened.append('chrome'))
        auto.poll()
        self.assertEqual(starts, ['start'])
        self.assertEqual(opened, [])
        r.qr = b'<svg/>'
        r.set('qr')
        r.set('qr')
        self.assertEqual(opened, ['chrome'])
        r.set('failed')
        auto.poll()
        restarted = m.AutoRecovery(r, marker, lambda: 'incident-one', lambda: opened.append('duplicate'))
        restarted.poll()
        self.assertEqual(starts, ['start'])
        self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
        # A newly authenticated bridge can have a separate future incident.
        restarted.probe = lambda: 'incident-two'
        restarted.poll()
        r.set('password')
        self.assertEqual(starts, ['start', 'start'])
        self.assertEqual(opened, ['chrome', 'duplicate'])

    def test_auto_ignores_timeout_busy_and_failed_monitor(self):
        # Offline/health timeout is not a revoked key; an ongoing human login
        # remains untouched even if the old bridge has invalid-session logs.
        r = self.recovery(None)
        marker = Path(self.temp.name) / 'attempt'
        auto = m.AutoRecovery(r, marker, lambda: None, lambda: self.fail('no window'))
        auto.poll()
        self.assertFalse(marker.exists())
        auto.probe = lambda: (_ for _ in ()).throw(OSError('private journal error'))
        auto.poll()
        self.assertFalse(marker.exists())
        r.set('password')
        auto.probe = lambda: self.fail('busy login must not inspect old incident')
        auto.poll()

    def test_auto_browser_failure_keeps_qr_and_does_not_retry(self):
        # A locked desktop or missing Chrome cannot cause repeated login/window
        # attempts; the permanent page remains available for a manual recovery.
        r = self.recovery(None)
        auto = m.AutoRecovery(r, Path(self.temp.name) / 'attempt', lambda: None,
                              lambda: (_ for _ in ()).throw(OSError('private error')))
        auto.pending_open = True
        r.qr = b'<svg/>'
        with patch('builtins.print') as log:
            r.set('qr')
            r.set('qr')
        self.assertEqual(log.call_count, 1)
        self.assertEqual(r.snapshot()['status'], 'qr')
        self.assertEqual(r.qr, b'<svg/>')

    def test_chrome_uses_xdg_without_changing_default_browser(self):
        # GNOME must not dispatch to the owner's default Yandex. Child-only
        # X-Generic/BROWSER preserve the rest of the desktop environment.
        with patch.object(m.subprocess, 'run') as run:
            m.open_chrome()
        args, kwargs = run.call_args
        self.assertEqual(args[0], ['/usr/bin/xdg-open', 'http://127.0.0.1:34771/'])
        self.assertEqual(kwargs['env']['XDG_CURRENT_DESKTOP'], 'X-Generic')
        self.assertEqual(kwargs['env']['BROWSER'], str(Path(m.__file__).with_name('telegram-recovery-chrome')))
        self.assertEqual(kwargs['env']['DISPLAY'], '')
        self.assertEqual(kwargs['env']['WAYLAND_DISPLAY'], '')
        self.assertEqual(kwargs['env']['MESSENGER_RECOVERY_DISPLAY'], m.os.environ.get('DISPLAY', ''))
        self.assertNotIn('password', str(args))

    def test_auth_probe_only_accepts_current_invocation_explicit_auth_errors(self):
        # Old invalid-key logs cannot trigger against a freshly logged-in bridge;
        # the journal query is bound to systemd's exact active invocation ID.
        invocation = 'a' * 32
        def probe(body):
            with patch.object(m.subprocess, 'run', side_effect=[SimpleNamespace(stdout=invocation), SimpleNamespace(stdout=body)]) as run:
                result = m.auth_failure_invocation()
                self.assertIn('_SYSTEMD_INVOCATION_ID=' + invocation, run.call_args.args[0])
                return result
        self.assertIsNone(probe(json.dumps({'MESSAGE': 'upstream_timeout request_timeout'})))
        self.assertIsNone(probe('not json'))
        self.assertEqual(probe(json.dumps({'MESSAGE': 'telethon.errors.AuthKeyDuplicatedError: revoked'})), invocation)
        self.assertEqual(probe(json.dumps({'MESSAGE': 'SESSION_REVOKED'})), invocation)

    def test_real_form_proxy_origin_and_stale_csrf(self):
        r = self.recovery(None)
        r.set('password')
        server = ThreadingHTTPServer(('127.0.0.1', 0), m.make_handler(r))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}'
        page = urlopen(base).read().decode()
        token = page.split("const csrf='")[1].split("'")[0]
        def post(token, host=None):
            headers = {'Origin': 'null'}
            if host:
                headers['Host'] = host
            request = Request(base + '/password', data=urlencode({'csrf': token, 'password': 'Synthetic + & = пароль'}).encode(), headers=headers)
            try:
                with urlopen(request) as response:
                    return response.status, json.load(response)
            except HTTPError as e:
                with e:
                    return e.code, json.load(e)
        self.assertEqual(post('stale')[1]['error'], 'stale_form')
        self.assertEqual(post(token, 'attacker.invalid')[0], 403)
        self.assertTrue(r.passwords.empty())
        self.assertEqual(post(token)[0], 200)
        self.assertEqual(r.passwords.get_nowait(), 'Synthetic + & = пароль')
        self.assertEqual(post(token)[0], 409)

    def test_qr_two_factor_rejection_then_success_disconnects(self):
        # Exercise the actual QR/2FA driver with a fake Telethon module. A real
        # rejected password may show password_invalid; stale form errors cannot.
        class Needed(Exception):
            pass
        class Invalid(Exception):
            pass
        class Flood(Exception):
            pass
        calls = []
        class Client:
            def __init__(self, *args, **kwargs):
                self.session = SimpleNamespace(save=lambda: 'synthetic-session')
            async def connect(self):
                calls.append('connect')
            async def disconnect(self):
                calls.append('disconnect')
            async def qr_login(self):
                async def wait(**kwargs):
                    raise Needed()
                return SimpleNamespace(url='synthetic', expires=datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=30), wait=wait)
            async def sign_in(self, password):
                calls.append('password')
                if calls.count('password') == 1:
                    raise Invalid()
            async def get_me(self):
                return SimpleNamespace(id=123)
        modules = {
            'dotenv': SimpleNamespace(dotenv_values=lambda _: {'TELEGRAM_API_ID': '1', 'TELEGRAM_API_HASH': 'synthetic'}),
            'telethon': SimpleNamespace(TelegramClient=Client, errors=SimpleNamespace(SessionPasswordNeededError=Needed, PasswordHashInvalidError=Invalid, FloodWaitError=Flood)),
            'telethon.sessions': SimpleNamespace(StringSession=lambda: None),
            'qrcode': SimpleNamespace(make=lambda *a, **k: SimpleNamespace(save=lambda buf: buf.write(b'<svg/>'))),
            'qrcode.image.svg': SimpleNamespace(SvgPathImage=None),
            'telegram_mcp.client_identity': SimpleNamespace(client_identity_kwargs=lambda: {}),
            'telegram_mcp.install_guard': SimpleNamespace(assert_safe_distribution=lambda: None),
        }
        r = self.recovery(None)
        stages = []
        original_set = r.set
        def set_and_supply(status, reason=None):
            stages.append(status)
            original_set(status, reason)
            if status in {'password', 'password_invalid'}:
                self.assertTrue(r.password('synthetic-password'))
        r.set = set_and_supply
        with patch.dict('sys.modules', modules):
            result = asyncio.run(m.telegram_login(r, Path(self.temp.name)))
        self.assertEqual(result, (123, 'synthetic-session'))
        self.assertIn('qr', stages)
        self.assertIn('password_invalid', stages)
        self.assertEqual(calls, ['connect', 'password', 'password', 'disconnect'])


if __name__ == '__main__':
    unittest.main()
