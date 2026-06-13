#!/usr/bin/env bash
# Capture a set of routes into shots/<tag>/. Assumes server already on :8099.
cd "$(dirname "$0")/../.."
TAG="${1:-after}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="scripts/ui-preview/shots/$TAG"
mkdir -p "$OUT"
shift || true
ROUTES=(
  "overview:/"
  "campaigns:/campaigns"
  "campaign-detail:/campaigns/camp-1"
  "leads:/leads"
  "lead-detail:/leads/biz-1"
  "lists:/lists"
  "list-detail:/lists/list-1"
  "analytics:/analytics"
  "scoring:/scoring"
  "calls:/calls"
  "call-detail:/calls/call-1"
  "settings:/settings"
)
[ "$#" -gt 0 ] && ROUTES=("$@")
for entry in "${ROUTES[@]}"; do
  name="${entry%%:*}"; hash="${entry#*:}"
  rm -f "$OUT/$name.png"
  "$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars \
    --force-color-profile=srgb --user-data-dir="$(mktemp -d)" --window-size=1480,1700 \
    --virtual-time-budget=4500 --screenshot="$OUT/$name.png" \
    "http://localhost:8099/scripts/ui-preview/preview.html#$hash" >/dev/null 2>&1 &
  cpid=$!
  # Watchdog: chrome won't self-exit (infinite bg animation). Wait for the PNG, then kill.
  for _ in $(seq 1 30); do
    sleep 0.4
    [ -s "$OUT/$name.png" ] && break
  done
  sleep 0.3
  kill -9 "$cpid" 2>/dev/null || true
  pkill -9 -P "$cpid" 2>/dev/null || true
  echo "$([ -s "$OUT/$name.png" ] && echo OK || echo --) $name"
done
pkill -9 -f "Google Chrome.*headless" 2>/dev/null || true
echo "SNAP_COMPLETE"
