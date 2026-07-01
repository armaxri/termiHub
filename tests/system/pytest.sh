#!/usr/bin/env bash
# Run the termiHub Python system tests via uv.
#
# Thin wrapper around `uv run pytest` that runs from tests/system regardless of
# where you call it, so you never manage the venv by hand. All arguments are
# forwarded verbatim to `python -m pytest`:
#
#   ./pytest.sh -m "not integration" -v
#   ./pytest.sh -m integration -k ssh -v -s
#   ./pytest.sh --collect-only -q
#
# On first run uv creates tests/system/.venv and installs the exact dependency
# set pinned in uv.lock (`--frozen` = use the committed lock, never re-resolve).
# After changing dependencies in pyproject.toml, run `uv lock` to refresh it.
#
# Pick a specific base interpreter with UV_PYTHON=/path/to/python3 (or a version
# like UV_PYTHON=3.12); the legacy PYTHON=... override is honored for
# compatibility.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v uv >/dev/null 2>&1; then
    echo "error: 'uv' not found on PATH." >&2
    echo "  Install it from https://docs.astral.sh/uv/ (e.g. 'curl -LsSf https://astral.sh/uv/install.sh | sh')." >&2
    exit 1
fi

# Backward-compat: map the old PYTHON override onto uv's UV_PYTHON.
if [ -n "${PYTHON:-}" ] && [ -z "${UV_PYTHON:-}" ]; then
    export UV_PYTHON="$PYTHON"
fi

exec uv run --frozen pytest "$@"
