#!/usr/bin/env bash
# Run the termiHub Python system tests, creating the venv on first use.
#
# Wraps the harness virtualenv so you never type the .venv path. All arguments
# are forwarded verbatim to `python -m pytest`:
#
#   ./pytest.sh -m "not integration" -v
#   ./pytest.sh -m integration -k ssh -v -s
#   ./pytest.sh --collect-only -q
#
# On first run it creates tests/system/.venv and installs requirements.txt;
# afterwards it just forwards to the existing venv. Override the base
# interpreter with PYTHON=/path/to/python3.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR=".venv"
VENV_PYTHON="$VENV_DIR/bin/python"

if [ ! -x "$VENV_PYTHON" ]; then
    PYTHON_BIN="${PYTHON:-python3}"
    if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
        echo "error: '$PYTHON_BIN' not found on PATH (set PYTHON=... to override)" >&2
        exit 1
    fi
    echo "Creating Python virtualenv in $SCRIPT_DIR/$VENV_DIR ..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
    "$VENV_PYTHON" -m pip install --quiet --upgrade pip
    "$VENV_PYTHON" -m pip install --quiet -r requirements.txt
    echo "virtualenv ready."
fi

exec "$VENV_PYTHON" -m pytest "$@"
