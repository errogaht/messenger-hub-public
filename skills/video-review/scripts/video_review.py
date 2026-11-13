#!/usr/bin/env python3
"""Thin standalone entry point; paid/cache logic lives in the canonical Hub core.

No daemon or provider session is required. Import aliasing also keeps existing
local receipt regression tests patching the same implementation globals.
"""
import importlib.util
import os
import json
from pathlib import Path
import sys

# Source checkouts resolve locally; installed wrappers use private operator
# settings written by the installer. Never accept core paths from tool input.
settings = Path.home() / '.config/messenger-hub/video-review.json'
configured = os.environ.get('VIDEO_REVIEW_CORE')
if not configured and settings.is_file():
    configured = json.loads(settings.read_text()).get('corePath')
path = Path(configured) if configured else Path(__file__).resolve().parents[3] / 'video-review/core.py'
if not path.is_absolute() or not path.is_file():
    raise SystemExit('Configure VIDEO_REVIEW_CORE or install the Video Review wrapper from its checkout')
spec = importlib.util.spec_from_file_location('video_review_shared_core', path)
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
if __name__ == '__main__':
    try:
        sys.exit(core.main())
    except (RuntimeError, ValueError, OSError, KeyError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
else:
    sys.modules[__name__] = core
