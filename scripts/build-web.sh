#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/zhuangxiu_app"
WEB_BUILD_DIR="$APP_DIR/build/web"
PUBLIC_DIR="$ROOT_DIR/server/public"
API_BASE_URL="${API_BASE_URL:-https://yinnkhome.com/api}"

if ! command -v flutter >/dev/null 2>&1; then
  echo "Flutter is required to build the web app." >&2
  exit 1
fi

cd "$APP_DIR"
flutter pub get
flutter build web \
  --release \
  --no-web-resources-cdn \
  --dart-define="API_BASE_URL=$API_BASE_URL"

bash "$ROOT_DIR/scripts/check-web-build.sh" "$WEB_BUILD_DIR"

mkdir -p "$PUBLIC_DIR"
rsync -a "$WEB_BUILD_DIR"/ "$PUBLIC_DIR"/
bash "$ROOT_DIR/scripts/check-web-build.sh" "$PUBLIC_DIR"

echo "Web build copied to server/public without Flutter CDN resources."
