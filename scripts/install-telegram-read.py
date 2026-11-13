#!/usr/bin/env python3
"""Install the pinned read bridge into the EXISTING Telegram MCP distribution.

Content-addressed backups preserve prior module registration for rollback. This
copies code only, never session/auth state; service restart is a separate step.
"""
import hashlib
import argparse
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / 'bridges/telegram-hub-read.py'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--bridge', type=Path, default=Path.home() / '.hermes/mcp-servers/telegram-mcp')
args = parser.parse_args()
target = args.bridge.resolve() / 'telegram_mcp/tools/hub_read.py'
registration = target.with_name('__init__.py')
backup = root / '.private/hub043-rollback/bridge'
backup.mkdir(parents=True, exist_ok=True, mode=0o700)
if not registration.is_file():
    raise SystemExit('existing_telegram_bridge_required')
for path in [target, registration]:
    if path.exists():
        data = path.read_bytes()
        saved = backup / (path.name + '.' + hashlib.sha256(data).hexdigest())
        if not saved.exists():
            saved.write_bytes(data)
            saved.chmod(0o600)
target.write_bytes(source.read_bytes())
line = 'from telegram_mcp.tools.hub_read import *'
text = registration.read_text()
if line not in text.splitlines():
    registration.write_text(text.rstrip() + '\n\n# Structured read-only Hub peer addressing, same runtime clients.\n' + line + '\n')
print('Pinned Telegram read bridge installed; existing runtime/session ownership retained.')
