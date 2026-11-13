#!/usr/bin/env python3
"""Build a new, allowlisted public snapshot without private Git or runtime state.

The operator supplies a private redaction policy; its values and original source
history never become export metadata. This is deliberately not a repository mirror.
A separate secret scan and human privacy review remain release requirements.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOP = {'README.md', 'LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
       'package.json', 'package-lock.json', 'config.example.json', '.gitignore', '.gitattributes', 'requirements-dev.txt'}
DIRS = {'src', 'bridges', 'prompts', 'test', 'video-review', 'skills', 'licenses', 'docs'}
INSTALLERS = {'install-telegram-read.py', 'install-video-review.py',
              'install-telegram-recovery.py', 'telegram-recovery.py',
              'telegram-recovery.html', 'telegram-recovery-chrome', 'export-public-release.py', 'import-profiles.mjs'}
EXCLUDED = {'test/telegram-bridge-media.py'}
SUFFIXES = {'.mjs', '.py', '.php', '.md', '.json', '.patch', '.sh', '.html', '.txt'}


def public_markdown(text):
    """Remove internal acceptance receipts, not implementation contracts.

    Private evidence is stored in excluded reports/tasks. Public docs must not
    pretend that historical owner-specific installations verify a new deployment.
    """
    blocks = re.split(r'\n\s*\n', text)
    internal = re.compile(r'reports/|PROJECT_STATUS\.md|audit-system\.mjs|verify-retest-fixes\.mjs|verify-search-html-fixes\.mjs|smoke-contact-agent\.mjs|video-smoke\.mjs|Installed buildId:|Implementation commit:|Current recovery installation:')
    return '\n\n'.join(block for block in blocks if not internal.search(block)).rstrip() + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--policy', type=Path, required=True)
    args = parser.parse_args()
    destination = args.destination.resolve()
    # Never overwrite a reviewed release or modify a live checkout by accident.
    if destination.exists() or destination == ROOT or ROOT in destination.parents and '.private' not in destination.relative_to(ROOT).parts:
        parser.error('destination must be new and outside the checkout (or under .private)')
    policy = json.loads(args.policy.read_text())
    replacements = policy.get('replace', {})
    forbidden = policy.get('forbidden', [])
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    # New release docs are explicit additions, not an untracked directory walk.
    candidates = set(tracked) | TOP | {'docs/installation.md', 'docs/public-release.md', 'licenses/Apache-2.0.txt'}
    payload = {}
    for name in sorted(candidates):
        if not name or name in EXCLUDED:
            continue
        relative = Path(name)
        allowed = name in TOP or (relative.parts[0] in DIRS and relative.suffix in SUFFIXES) or (relative.parts[0] == 'scripts' and relative.name in INSTALLERS)
        if not allowed:
            continue
        source = ROOT / relative
        if source.is_symlink() or not source.is_file() or ROOT not in source.resolve().parents:
            raise SystemExit('unsafe or missing export source: ' + name)
        text = source.read_text()
        if relative.suffix == '.md':
            text = public_markdown(text)
        for original, synthetic in replacements.items():
            text = text.replace(original, synthetic)
        if any(value in text for value in forbidden):
            raise SystemExit('privacy policy failed in ' + name)
        payload[name] = (text.encode(), source.stat().st_mode & 0o111)
    # Validate everything before creating the destination; failures leave no
    # plausible-looking partial release. A manifest makes later changes visible.
    destination.mkdir(parents=True)
    manifest = {}
    for name, (data, executable) in payload.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o755 if executable else 0o644)
        manifest[name] = hashlib.sha256(data).hexdigest()
    (destination / 'SHA256SUMS').write_text(''.join(digest + '  ' + name + '\n' for name, digest in manifest.items()))
    print(json.dumps({'destination': str(destination), 'files': len(payload), 'historyIncluded': False}))


if __name__ == '__main__':
    main()
