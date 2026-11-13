#!/usr/bin/env python3
"""Install only the thin skill files, preserving private cache/credentials/jobs.

Content-addressed backups make installation reversible; running Python processes
keep their already loaded core. This never installs providers or creates sessions.
"""
from pathlib import Path
import hashlib
import shutil
import json

root = Path(__file__).resolve().parents[1]
source = root / 'skills/video-review'
target = Path.home() / '.codex/skills/video-review'
backup = root / '.private/hub039-rollback/skill'
for relative in ['SKILL.md', 'scripts/video_review.py', 'scripts/video-review.sh',
                 'references/configuration.md', 'references/defaults.json']:
    src, dst = source / relative, target / relative
    if dst.exists() and dst.read_bytes() == src.read_bytes():
        continue
    if dst.exists():
        digest = hashlib.sha256(dst.read_bytes()).hexdigest()
        old = backup / (relative + '.' + digest)
        old.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not old.exists():
            shutil.copy2(dst, old)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    dst.chmod(0o755 if relative.endswith(('.py', '.sh')) else 0o644)
# A private path setting makes the installed thin wrapper independent of the
# author's username and checkout location, without changing paid/cache identity.
settings = Path.home() / '.config/messenger-hub/video-review.json'
settings.parent.mkdir(parents=True, exist_ok=True)
if settings.exists():
    old = backup / ('video-review.json.' + hashlib.sha256(settings.read_bytes()).hexdigest())
    old.parent.mkdir(parents=True, exist_ok=True)
    if not old.exists():
        shutil.copy2(settings, old)
        old.chmod(0o600)
settings.touch(mode=0o600, exist_ok=True)
settings.chmod(0o600)
settings.write_text(json.dumps({'corePath': str(root / 'video-review/core.py')}) + '\n')
print('Video Review thin wrapper installed; private cache and credentials unchanged.')
