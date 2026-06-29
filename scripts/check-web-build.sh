#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:-$ROOT_DIR/server/public}"

if [ ! -d "$TARGET_DIR" ]; then
  echo "Missing web build directory: $TARGET_DIR" >&2
  exit 1
fi

if ! grep -q '"useLocalCanvasKit":true' "$TARGET_DIR/flutter_bootstrap.js"; then
  echo "Web build check failed: Flutter is not configured to use local CanvasKit." >&2
  exit 1
fi

if [ ! -f "$TARGET_DIR/canvaskit/canvaskit.js" ]; then
  echo "Web build check failed: local CanvasKit files are missing." >&2
  exit 1
fi

echo "Web build check passed: CanvasKit is local."
