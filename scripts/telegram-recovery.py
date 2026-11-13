#!/usr/bin/env python3
"""Owner-only recovery UI for the existing Telegram bridge, never an MCP grant.

Normal startup checks Hub and explicit current-bridge auth failures. The owner
has authorized one automatic recovery/browser prompt per confirmed auth incident.
Manual CSRF-protected recovery remains available. Each bounded login stops the
bridge, verifies the configured owner,
and installs auth only in that bridge. Passwords/QR/session bytes stay in memory.
Run using the existing bridge venv; no extra dependency or auth copy is needed.
"""
import argparse
import asyncio
import fcntl
import json
import os
from pathlib import Path
import queue
import re
import secrets
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs
from urllib.request import Request, urlopen

BUSY = {'starting', 'qr', 'password', 'password_invalid', 'password_checking', 'verifying'}
AUTH_FAILURE = re.compile(r'\b(?:AUTH_KEY_DUPLICATED|AuthKeyDuplicatedError|AUTH_KEY_UNREGISTERED|AuthKeyUnregisteredError|SESSION_REVOKED|SessionRevokedError|SESSION_EXPIRED|SessionExpiredError)\b')


def open_chrome(port=34771):
    """Use xdg-open's generic BROWSER path without changing desktop defaults.

    GNOME normally ignores BROWSER and picks the owner's default Yandex. The
    X-Generic override and hidden display bypass desktop MIME dispatch. The
    pinned browser wrapper restores DISPLAY/Wayland only for Chrome itself.
    Only the fixed loopback URL crosses argv, never QR/password/session data.
    """
    env = dict(os.environ, XDG_CURRENT_DESKTOP='X-Generic',
               BROWSER=str(Path(__file__).with_name('telegram-recovery-chrome')),
               MESSENGER_RECOVERY_DISPLAY=os.environ.get('DISPLAY', ''),
               MESSENGER_RECOVERY_WAYLAND_DISPLAY=os.environ.get('WAYLAND_DISPLAY', ''),
               DISPLAY='', WAYLAND_DISPLAY='')
    subprocess.run(['/usr/bin/xdg-open', f'http://127.0.0.1:{port}/'], env=env,
                   check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def auth_failure_invocation():
    """Recognize explicit revoked-key errors only in the currently running bridge.

    Journal bodies are inspected locally and never returned/stored. A current
    invocation boundary excludes yesterday's errors after successful re-login.
    A timeout, journal permission failure or absent service cannot imply logout.
    """
    invocation = subprocess.run(['systemctl', '--user', 'show', 'telegram-mcp.service',
                                 '--property=InvocationID', '--value'], capture_output=True, text=True, check=True, timeout=5).stdout.strip()
    if not re.fullmatch(r'[a-f0-9]{32}', invocation):
        return None
    lines = subprocess.run(['journalctl', '--user', '-u', 'telegram-mcp.service',
                            '_SYSTEMD_INVOCATION_ID=' + invocation, '-n', '200', '--no-pager', '-o', 'json'],
                           capture_output=True, text=True, check=True, timeout=5).stdout.splitlines()
    for line in lines:
        try:
            message = json.loads(line).get('MESSAGE', '')
        except (ValueError, AttributeError):
            continue
        if isinstance(message, str) and AUTH_FAILURE.search(message):
            return invocation
    return None


class AutoRecovery:
    """One durable attempt per failed bridge invocation, with QR-ready opening.

    Persist the incident before starting side effects, so a recovery-service
    restart cannot reopen windows/retry login endlessly. Failure needs a human
    retry; a newly authenticated bridge has a new systemd invocation and can
    trigger a later independent incident. Dependencies are fakeable in tests.
    """
    def __init__(self, recovery, marker, probe=auth_failure_invocation, opener=open_chrome):
        self.recovery, self.marker, self.probe, self.opener = recovery, marker, probe, opener
        self.pending_open = False
        self.lock = threading.Lock()
        recovery.on_prompt = self.prompt

    def poll(self):
        if self.recovery.snapshot()['status'] in BUSY:
            return
        try:
            incident = self.probe()
            if not incident:
                return
            with self.lock:
                if self.marker.exists() and self.marker.read_text().strip() == incident:
                    return
                self.marker.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                # The process-wide recovery flock makes this single-writer; no
                # secrets are stored, just the attempted systemd invocation ID.
                fd = os.open(self.marker, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, 'w') as out:
                    out.write(incident + '\n')
                    out.flush()
                    os.fsync(out.fileno())
                self.pending_open = True
                if not self.recovery.begin():
                    self.pending_open = False
        except Exception:
            # Monitoring failures must not terminate the UI or manufacture auth
            # expiry. Never log journal/provider bodies or credential details.
            return

    def prompt(self):
        with self.lock:
            if not self.pending_open:
                return
            self.pending_open = False
        try:
            self.opener()
        except Exception:
            # The QR stays usable at the permanent URL; do not spawn a storm
            # when DISPLAY/Chrome is unavailable or the desktop is locked.
            print('Telegram recovery: automatic browser open failed; use local page.', flush=True)



def install_session(env, original, session):
    """Compare before atomic replace: concurrent credential edits must not be lost.

    No backup of auth is made. Existing unrelated settings survive byte-for-byte;
    the new key never passes argv, logs, status or the Hub configuration.
    """
    if env.read_text() != original:
        raise RuntimeError('credentials_changed')
    pattern = r'(?m)^TELEGRAM_SESSION_STRING\s*=.*$'
    if len(re.findall(pattern, original)) != 1 or not re.fullmatch(r'[A-Za-z0-9_\-=]+', session):
        raise RuntimeError('credentials_format')
    updated = re.sub(pattern, lambda _: 'TELEGRAM_SESSION_STRING=' + session, original)
    temp = env.with_name('.env.recovery-' + secrets.token_hex(8))
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as out:
            out.write(updated)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, env)
    finally:
        temp.unlink(missing_ok=True)


class Recovery:
    """Thread-safe state machine; dependencies are injected for offline tests.

    All service/client side effects belong to one worker. Browser requests only
    enqueue a single password or start intent; they cannot pick account or paths.
    """
    def __init__(self, expected, health, login, service, env):
        self.expected, self.health, self.login = str(expected), health, login
        self.service, self.env = service, env
        self.lock = threading.RLock()
        self.passwords = queue.Queue(maxsize=1)
        self.state = {'status': 'checking', 'reason': None}
        self.qr = b''
        self.checking = False
        self.on_prompt = None

    def set(self, status, reason=None):
        with self.lock:
            self.state = {'status': status, 'reason': reason, 'checkedAt': time.time()}
        # Only QR/2FA readiness opens the browser, never a half-started login.
        if status in {'qr', 'password'} and self.on_prompt:
            self.on_prompt()

    def snapshot(self):
        with self.lock:
            return dict(self.state)

    def check(self):
        """Read-only check: unavailable is not proof of an expired auth key."""
        with self.lock:
            if self.state['status'] in BUSY or self.checking:
                return
            self.checking = True
        try:
            result = self.health()
            ok = (result.get('available') is True and result.get('configuredSelfMatches') is True
                  and str(result.get('self', {}).get('id')) == self.expected)
            with self.lock:
                if self.state['status'] not in BUSY:
                    self.set('connected' if ok else 'unavailable')
        except Exception:
            with self.lock:
                if self.state['status'] not in BUSY:
                    self.set('unavailable', 'hub_unavailable')
        finally:
            with self.lock:
                self.checking = False

    def begin(self):
        with self.lock:
            if self.state['status'] in BUSY:
                return False
            self.set('starting')
            while not self.passwords.empty():
                self.passwords.get_nowait()
            threading.Thread(target=lambda: asyncio.run(self.run()), daemon=True).start()
            return True

    def password(self, value):
        with self.lock:
            if self.state['status'] not in {'password', 'password_invalid'} or not value:
                return False
            self.set('password_checking')
            self.passwords.put_nowait(value)
            return True

    async def run(self):
        stopped = False
        try:
            if self.env.stat().st_mode & 0o077:
                raise RuntimeError('credentials_permissions')
            original = self.env.read_text()
            self.service('stop')
            stopped = True
            # login() owns/disconnects the temporary client BEFORE returning.
            account, session = await self.login(self)
            if str(account) != self.expected:
                self.set('failed', 'account_mismatch')
                return
            install_session(self.env, original, session)
            session = None
            self.set('verifying')
            self.service('start')
            stopped = False
            for _ in range(10):
                try:
                    r = self.health()
                    if (r.get('available') is True and r.get('configuredSelfMatches') is True
                            and str(r.get('self', {}).get('id')) == self.expected):
                        self.set('connected')
                        return
                except Exception:
                    pass
                await asyncio.sleep(2)
            self.set('installed_unverified', 'health_not_verified')
        except Exception as exc:
            # Never serialize exception messages: RPC errors can contain secrets.
            safe = str(exc) if type(exc) is RuntimeError else ''
            self.set('failed', safe if safe in {'credentials_changed', 'credentials_format', 'credentials_permissions', 'qr_timeout', 'password_timeout', 'password_attempt_limit', 'flood_wait'} else 'recovery_failed')
        finally:
            self.qr = b''
            while not self.passwords.empty():
                self.passwords.get_nowait()
            if stopped:
                # Even a failed/mismatched login must not strand the old service.
                try:
                    self.service('start')
                except Exception:
                    self.set('failed', 'bridge_start_failed')


async def telegram_login(recovery, bridge):
    """Fresh memory session; no saved key is opened by a second Telegram client."""
    import datetime
    import io
    import sys
    from dotenv import dotenv_values
    from telethon import TelegramClient, errors
    from telethon.sessions import StringSession
    import qrcode
    from qrcode.image.svg import SvgPathImage
    sys.path.insert(0, str(bridge))
    from telegram_mcp.client_identity import client_identity_kwargs
    from telegram_mcp.install_guard import assert_safe_distribution
    assert_safe_distribution()
    config = dotenv_values(recovery.env)
    client = TelegramClient(StringSession(), int(config['TELEGRAM_API_ID']), config['TELEGRAM_API_HASH'], **client_identity_kwargs())
    try:
        await client.connect()
        qr = await client.qr_login()
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            image = qrcode.make(qr.url, image_factory=SvgPathImage)
            buf = io.BytesIO()
            image.save(buf)
            recovery.qr = buf.getvalue()
            recovery.set('qr')
            try:
                seconds = max(1, (qr.expires - datetime.datetime.now(datetime.timezone.utc)).total_seconds() - 1)
                await qr.wait(timeout=min(seconds, max(1, deadline - time.monotonic())))
                break
            except asyncio.TimeoutError:
                await qr.recreate()
            except errors.SessionPasswordNeededError:
                recovery.qr = b''
                recovery.set('password')
                for _ in range(3):
                    try:
                        password = await asyncio.to_thread(recovery.passwords.get, True, 600)
                    except queue.Empty:
                        raise RuntimeError('password_timeout') from None
                    try:
                        await client.sign_in(password=password)
                        break
                    except errors.PasswordHashInvalidError:
                        recovery.set('password_invalid')
                    finally:
                        password = None
                else:
                    raise RuntimeError('password_attempt_limit')
                break
        else:
            raise RuntimeError('qr_timeout')
        me = await client.get_me()
        return me.id if me else None, client.session.save()
    except errors.FloodWaitError:
        raise RuntimeError('flood_wait') from None
    finally:
        await client.disconnect()


def make_handler(recovery):
    """CSRF capability and loopback Host protect writes; Origin is not relied on.

    Embedded/proxied browsers can rewrite Origin. An exact per-process token from
    the same-origin page remains mandatory. No CORS, token in URLs, or logs.
    """
    token = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, code, value, content_type='application/json; charset=utf-8'):
            body = value if isinstance(value, bytes) else json.dumps(value).encode()
            self.send_response(code)
            for key, val in {'Content-Type': content_type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'"}.items():
                self.send_header(key, val)
            self.end_headers()
            self.wfile.write(body)

        def local(self):
            return self.headers.get('Host') in {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}

        def do_GET(self):
            if not self.local():
                return self.reply(403, {'error': 'local_only'})
            if self.path == '/':
                page = Path(__file__).with_name('telegram-recovery.html').read_text().replace('__CSRF__', token)
                return self.reply(200, page.encode(), 'text/html; charset=utf-8')
            if self.path == '/status':
                return self.reply(200, recovery.snapshot())
            if self.path.split('?')[0] == '/qr.svg':
                return self.reply(200, recovery.qr, 'image/svg+xml')
            return self.reply(404, {'error': 'not_found'})

        def do_POST(self):
            if not self.local():
                return self.reply(403, {'error': 'local_only'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 4096:
                    raise ValueError()
                form = parse_qs(self.rfile.read(length).decode('utf-8'))
            except (ValueError, UnicodeError):
                return self.reply(400, {'error': 'invalid_form'})
            if not secrets.compare_digest(form.get('csrf', [''])[0], token):
                return self.reply(403, {'error': 'stale_form', 'message': 'Страница устарела. Обновите её и повторите ввод.'})
            if self.path == '/start':
                return self.reply(200 if recovery.begin() else 409, {'status': recovery.snapshot()['status']})
            if self.path == '/password':
                accepted = recovery.password(form.get('password', [''])[0])
                return self.reply(200 if accepted else 409, {'status': recovery.snapshot()['status']})
            if self.path == '/check':
                threading.Thread(target=recovery.check, daemon=True).start()
                return self.reply(200, {'status': recovery.snapshot()['status']})
            return self.reply(404, {'error': 'not_found'})
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--bridge', type=Path, default=Path.home() / '.hermes/mcp-servers/telegram-mcp')
    parser.add_argument('--connection', default='telegram-main')
    parser.add_argument('--port', type=int, default=34771)
    parser.add_argument('--open-browser', action='store_true', help='Open the local page in Chrome via xdg-open, without starting login')
    args = parser.parse_args()
    if args.open_browser:
        open_chrome(args.port)
        return
    # The lock spans UI and login. A second launcher never starts another client.
    lock_path = Path.home() / '.config/messenger-hub/telegram-recovery.lock'
    lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('telegram_recovery_already_running') from None
        if args.config.stat().st_mode & 0o077:
            raise SystemExit('hub_config_permissions_must_be_0600')
        config = json.loads(args.config.read_text())
        connection = config['connections'][args.connection]
        if connection['plugin'] != 'telegram':
            raise SystemExit('telegram_connection_required')
        expected = connection['settings']['selfId']
        scope = next(s for s in config['scopes'].values() if s.get('connections', {}).get(args.connection, {}).get('read'))

        def health():
            request = Request(f"http://127.0.0.1:{config['port']}/api/v1/call", data=json.dumps({'method': 'health', 'input': {'connectionId': args.connection}}).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + scope['token']})
            with urlopen(request, timeout=12) as response:
                return json.load(response)['result']

        def service(action):
            subprocess.run(['systemctl', '--user', action, 'telegram-mcp.service'], check=True, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        recovery = Recovery(expected, health, lambda r: telegram_login(r, args.bridge), service, args.bridge / '.env')
        server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(recovery))
        auto = AutoRecovery(recovery, lock_path.with_name('telegram-recovery-auto-attempt'),
                            opener=lambda: open_chrome(args.port))
        def monitor():
            while True:
                # Journal classification runs before slow health checks so an
                # explicit revoked key is not hidden behind an MCP timeout.
                auto.poll()
                recovery.check()
                time.sleep(15)
        threading.Thread(target=monitor, daemon=True).start()
        print(f'Telegram recovery ready: http://127.0.0.1:{args.port}/', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Startup failures must never dump parsed private config or RPC bodies.
        raise SystemExit('telegram_recovery_startup_failed') from None
