#!/usr/bin/env bash
# Regenerate tests/golden/*.expected by running each design through Icarus Verilog.
#
# The .expected files are checked in, so `npm test` can compare our simulator
# against Icarus without needing iverilog installed. CI runs this script and
# then `git diff --exit-code` to prove the checked-in files really are what
# Icarus produces.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for src in tests/golden/*.v; do
  name="$(basename "$src" .v)"
  iverilog -g2005 -o "$tmp/$name.vvp" "$src"
  # Drop Icarus' own status lines ("... $finish called at ...", VCD info);
  # they are not part of the design's output.
  vvp -n "$tmp/$name.vvp" | tr -d '\r' | { grep -v -E '\$finish called at|^VCD info:' || true; } > "tests/golden/$name.expected"
  echo "updated tests/golden/$name.expected"
done
