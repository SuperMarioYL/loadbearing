#!/usr/bin/env bash
# Drives the recorded demo. Every command below runs for real; the cast is not
# edited after recording.
#
#   npm ci && npm run build && npm pack
#   asciinema rec --overwrite --output-format asciicast-v2 \
#     --window-size 100x34 --idle-time-limit 2 \
#     --title "Loadbearing: revert-probe necessity gate" \
#     --command "bash docs/record-demo.sh" docs/assets/demo.cast
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
demo="${DEMO_DIR:-/tmp/lb-demo}"
version="$(tr -d '[:space:]' < "$root/VERSION")"
tarball="$root/loadbearing-gate-$version.tgz"

if [ ! -f "$tarball" ]; then
  echo "missing $tarball; run npm pack in $root first" >&2
  exit 2
fi

cd "$root"
echo "\$ bash fixtures/seed-agent-pr.sh $demo"
bash fixtures/seed-agent-pr.sh "$demo"
sleep 1

cd "$demo"
sleep 1

echo
echo '$ loadbearing diff --base HEAD~1'
npx --yes "file:$tarball" diff --base HEAD~1
sleep 2

echo
echo '$ loadbearing check --base HEAD~1'
npx --yes "file:$tarball" check --base HEAD~1
sleep 3

echo
echo '$ loadbearing check --base HEAD~1 --json | head -24'
npx --yes "file:$tarball" check --base HEAD~1 --json | head -24
sleep 2
