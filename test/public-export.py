"""Privacy regression checks against fake repositories, never live account state."""
import contextlib
import io
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/export-public-release.py'))
MAIN = MODULE['main']
GLOBALS = MAIN.__globals__


class ExportBoundary(unittest.TestCase):
    def setUp(self):
        """Tracked private reports and untracked state must never reach an export."""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'source'
        self.root.mkdir()
        for name in GLOBALS['TOP'] | {'docs/installation.md', 'docs/public-release.md', 'licenses/Apache-2.0.txt'}:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('synthetic public content\n')
        for name in ['src/main.mjs', 'reports/private.md', '.private/config.json']:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('synthetic private content\n' if name != 'src/main.mjs' else '// safe source\n')
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'add', 'src', 'reports'], check=True)
        self.policy = self.base / 'policy.json'
        self.policy.write_text('{"forbidden":["synthetic private content"]}')
        self.destination = self.base / 'public'

    def run_export(self):
        with patch.dict(GLOBALS, ROOT=self.root), patch.object(sys, 'argv', ['export', str(self.destination), '--policy', str(self.policy)]), contextlib.redirect_stdout(io.StringIO()):
            MAIN()

    def test_private_state_and_history_are_excluded(self):
        # Both tracked operational reports and untracked credentials are outside
        # the allowlist; no original Git metadata or author email is imported.
        self.run_export()
        self.assertTrue((self.destination / 'src/main.mjs').is_file())
        for name in ['reports', '.private', '.git']:
            self.assertFalse((self.destination / name).exists())

    def test_new_private_text_aborts_before_destination_creation(self):
        # An accidentally tracked secret inside an allowed source directory must
        # fail closed, rather than create a plausible partial release.
        (self.root / 'src/main.mjs').write_text('synthetic private content')
        with self.assertRaises(SystemExit):
            self.run_export()
        self.assertFalse(self.destination.exists())

    def test_symlink_cannot_escape_source_tree(self):
        # A tracked source symlink cannot copy an operator file from elsewhere.
        (self.root / 'src/main.mjs').unlink()
        (self.root / 'src/main.mjs').symlink_to(self.policy)
        with self.assertRaises(SystemExit):
            self.run_export()
        self.assertFalse(self.destination.exists())


if __name__ == '__main__':
    unittest.main()
