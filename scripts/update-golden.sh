#!/usr/bin/env bash
# Regenerate tests/golden/*.expected by running each design through Icarus Verilog.
#
# A golden design is either tests/golden/<name>.v, or tests/golden/<name>.files
# listing several source files (paths from the repo root) that are simulated
# together — used for designs that live elsewhere, like boards/basys3/.
#
# The .expected files are checked in, so `npm test` can compare our simulator
# against Icarus without needing iverilog installed. CI runs this script and
# then `git diff --exit-code` to prove the checked-in files really are what
# Icarus produces.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for entry in tests/golden/*.v tests/golden/*.files; do
  [ -e "$entry" ] || continue
  name="$(basename "${entry%.*}")"
  if [[ "$entry" == *.files ]]; then
    mapfile -t sources < <(tr -d '\r' < "$entry" | grep -v '^\s*$')
  else
    sources=("$entry")
  fi
  iverilog -g2005 -o "$tmp/$name.vvp" "${sources[@]}"
  # Drop Icarus' own status lines ("... $finish called at ...", VCD info);
  # they are not part of the design's output.
  vvp -n "$tmp/$name.vvp" | tr -d '\r' | { grep -v -E '\$finish called at|^VCD info:' || true; } > "tests/golden/$name.expected"
  echo "updated tests/golden/$name.expected"
done
