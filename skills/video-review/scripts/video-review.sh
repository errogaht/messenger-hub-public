#!/usr/bin/env bash
# Resolve symlinks so personal and corporate homes run the same implementation.
set -euo pipefail
SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
exec python3 "$SCRIPT_DIR/video_review.py" "$@"
