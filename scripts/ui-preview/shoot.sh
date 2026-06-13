#!/usr/bin/env bash
# Screenshot every UI route against the mocked API.
# Usage: scripts/ui-preview/shoot.sh [tag]   (tag => subfolder, default "current")
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG="${1:-current}"
PORT="${PREVIEW_PORT:-8099}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUTDIR="scripts/ui-preview/shots/$TAG"
W="${PREVIEW_W:-1480}"
H="${PREVIEW_H:-1900}"
mkdir -p "$OUTDIR"

# Start a static server from repo root
python3 -m http.server "$PORT" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1

PROFILE="$(mktemp -d)"
trap 'kill $SRV 2>/dev/null || true; rm -rf "$PROFILE" 2>/dev/null || true' EXIT

shoot() {
  local name="$1" hash="$2" tries=0
  while [ $tries -lt 3 ]; do
    "$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
      --hide-scrollbars --force-color-profile=srgb --user-data-dir="$PROFILE/$name" \
      --window-size="$W,$H" --virtual-time-budget=6000 \
      --screenshot="$OUTDIR/$name.png" \
      "http://localhost:$PORT/scripts/ui-preview/preview.html#$hash" >/dev/null 2>&1 || true
    if [ -s "$OUTDIR/$name.png" ]; then echo "  ✓ $name"; return 0; fi
    tries=$((tries + 1)); sleep 1
  done
  echo "  ✗ $name (failed)"
}

echo "Shooting → $OUTDIR (${W}x${H})"
shoot overview        "/"
shoot campaigns       "/campaigns"
shoot campaign-detail "/campaigns/camp-1"
shoot leads           "/leads"
shoot lead-detail     "/leads/biz-1"
shoot lists           "/lists"
shoot list-detail     "/lists/list-1"
shoot analytics       "/analytics"
shoot scoring         "/scoring"
shoot calls           "/calls"
shoot call-detail     "/calls/call-1"
shoot settings        "/settings"
echo "Done."
