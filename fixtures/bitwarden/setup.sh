#!/usr/bin/env bash
# Clones bitwarden/clients at the pinned commit and installs it, for the fixture cases.
#
#   fixtures/bitwarden/setup.sh [dir]     (default: .cache/bitwarden)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dir=${1:-"$here/../../.cache/bitwarden"}
repo=$(node -p "require('$here/fixture.json').repository")
commit=$(node -p "require('$here/fixture.json').commit")

if [ ! -d "$dir/.git" ]; then
  # The cases replay up to 3,000 commits of history, so the clone is not shallow.
  git clone --filter=blob:none --no-checkout "$repo" "$dir"
fi
git -C "$dir" fetch -q origin "$commit" 2>/dev/null || true
git -C "$dir" checkout -q --detach "$commit"
git -C "$dir" reset -q --hard "$commit"
if [ ! -f "$dir/node_modules/.package-lock.json" ] || [ "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]; then
  (cd "$dir" && npm ci --ignore-scripts)
fi
echo "bitwarden fixture ready at $dir ($commit)"
