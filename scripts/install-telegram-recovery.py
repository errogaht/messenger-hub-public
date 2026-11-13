#!/usr/bin/env python3
"""Install only this pinned checkout's recovery UI; do not touch Telegram auth.

The persistent service opens one QR login after a confirmed revoked-key error.
ExecStopPost restores the old bridge after crash/stop during a bounded login.
"""
from pathlib import Path
import subprocess
import shlex
import argparse

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--bridge', type=Path, default=Path.home() / '.hermes/mcp-servers/telegram-mcp')
parser.add_argument('--config', type=Path, default=root / '.private/config.json')
args = parser.parse_args()
bridge = args.bridge.resolve()
python = bridge / '.venv/bin/python'
config = args.config.resolve()
if not python.is_file() or not config.is_file():
    raise SystemExit('existing_bridge_and_hub_config_required')

# Code paths are pinned here, never accepted from HTTP or MCP caller arguments.
def quote(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'

unit = Path.home() / '.config/systemd/user/messenger-telegram-recovery.service'
unit.parent.mkdir(parents=True, exist_ok=True)
unit.write_text(f'''[Unit]
Description=Messenger Hub Telegram recovery (owner-only loopback)
After=messenger-hub.service

[Service]
Type=simple
ExecStart={quote(python)} {quote(root / 'scripts/telegram-recovery.py')} --config {quote(config)} --bridge {quote(bridge)}
ExecStopPost=/usr/bin/systemctl --user start telegram-mcp.service
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
''')
command = Path.home() / '.local/bin/messenger-telegram-login'
command.parent.mkdir(parents=True, exist_ok=True)
command.write_text(f'''#!/bin/sh
# The launcher opens Chrome; the monitor alone classifies confirmed auth loss.
systemctl --user start messenger-telegram-recovery.service || exit "$?"
printf '%s\\n' 'Telegram: http://127.0.0.1:34771/'
exec {shlex.quote(str(python))} {shlex.quote(str(root / 'scripts/telegram-recovery.py'))} --config {shlex.quote(str(config))} --bridge {shlex.quote(str(bridge))} --open-browser
''')
command.chmod(0o700)
subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
subprocess.run(['systemctl', '--user', 'enable', '--now', unit.name], check=True)
print('Telegram recovery installed: http://127.0.0.1:34771/ (no login started)')
