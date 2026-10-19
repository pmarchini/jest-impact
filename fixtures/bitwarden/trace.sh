#!/usr/bin/env bash
# Regenerates trace.jsonl.gz: runs bitwarden's whole Jest suite once, recording
# the modules and data files each test loads. Takes about 25 minutes on 4 cores.
#
#   fixtures/bitwarden/trace.sh [dir]     (the checkout from setup.sh)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dir=$(cd "${1:-"$here/../../.cache/bitwarden"}" && pwd)
out=$(mktemp -d)
echo "$(git -C "$dir" rev-parse HEAD)" > "$out/COMMIT"
(cd "$dir" && TRACE_ROOT="$dir/" TRACE_DIR="$out" \
  NODE_OPTIONS="--require $here/../../validation/trace-jest.cjs --max-old-space-size=3072" \
  node_modules/.bin/jest -w 3 --ci --coverage=false --reporters=summary) || echo "some suites failed; their traces are still recorded"
cat "$out"/*.jsonl | node -e "
  const lines = require('fs').readFileSync(0, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  lines.sort((a, b) => a.test.localeCompare(b.test));
  process.stdout.write(lines.map(({ test, files, packages }) => JSON.stringify({ test, files, packages })).join('\n') + '\n');
" | gzip -9n > "$here/trace.jsonl.gz"
echo "commit $(cat "$out/COMMIT"); $(zcat "$here/trace.jsonl.gz" | wc -l) tests traced"
