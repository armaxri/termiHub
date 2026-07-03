#!/bin/bash
# Render a concept HTML to a PNG using headless Chrome, so concepts/mockups can be
# visually reviewed (and fidelity verified) without opening a browser by hand.
# Part of the AI-driven concept workflow.
#
# Works for both the single-file concept form (docs/concepts/<status>/<name>.html)
# and any legacy folder mockups (docs/concepts/<status>/<name>/mockups/*.html).
# A virtual-time budget lets client-side Mermaid finish rendering before capture.
#
# Usage:
#   scripts/internal/screenshot-mockup.sh <concept-or-mockup.html> [output.png] [width] [height]
#   scripts/internal/screenshot-mockup.sh --all          # render every concept/mockup to _assets/.preview/
#
# Output defaults to docs/concepts/_assets/.preview/<name>.png (gitignored).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PREVIEW_DIR="$REPO_ROOT/docs/concepts/_assets/.preview"

# Locate a Chrome/Chromium binary across platforms.
find_chrome() {
  local candidates=(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
    "google-chrome"
    "google-chrome-stable"
    "chromium"
    "chromium-browser"
  )
  for c in "${candidates[@]}"; do
    if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

CHROME="$(find_chrome)" || {
  echo "error: no Chrome/Chromium found. Install Chrome or open the mockup in a browser." >&2
  exit 1
}

shoot() {
  local html="$1" out="$2" w="${3:-1000}" h="${4:-1500}"
  mkdir -p "$(dirname "$out")"
  # --virtual-time-budget lets JS (Mermaid) run and settle before the capture;
  # --allow-file-access-from-files keeps vendored assets loadable under file://.
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --allow-file-access-from-files --virtual-time-budget=8000 \
    --force-device-scale-factor=2 --window-size="$w,$h" \
    --screenshot="$out" "file://$html" >/dev/null 2>&1 || true
  [ -f "$out" ] && echo "Wrote $out" || { echo "error: render failed for $html" >&2; return 1; }
}

# Find every renderable concept HTML: single-file concepts and legacy folder
# mockups, excluding shared assets and the generated gallery index.
find_concept_html() {
  find "$REPO_ROOT/docs/concepts" -type f -name '*.html' \
    ! -path '*/_assets/*' ! -name 'mockups-index.html' | sort
}

if [ "${1:-}" = "--all" ]; then
  found=0
  while IFS= read -r html; do
    found=1
    name="$(echo "$html" | sed "s|$REPO_ROOT/docs/concepts/||; s|/|__|g; s|\.html$||")"
    shoot "$html" "$PREVIEW_DIR/$name.png"
  done < <(find_concept_html)
  [ "$found" = 1 ] || echo "No concept HTML found."
  exit 0
fi

[ $# -ge 1 ] || { echo "usage: $0 <concept-or-mockup.html> [output.png] [width] [height]" >&2; exit 1; }

HTML="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[ -f "$HTML" ] || { echo "error: not found: $1" >&2; exit 1; }
OUT="${2:-$PREVIEW_DIR/$(basename "${1%.html}").png}"
shoot "$HTML" "$OUT" "${3:-1000}" "${4:-1500}"
