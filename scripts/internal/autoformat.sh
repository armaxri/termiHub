#!/bin/bash
# Auto-format a single file based on its extension.
# Designed to be called by a Claude Code PostToolUse hook.
# Reads JSON from stdin to extract the file path.

INPUT=$(cat)
# Parse the edited file path from the hook's JSON payload with Node rather than
# jq: Node is already a hard dependency of this script (`npx` below) and of the
# project, whereas jq is often absent (e.g. Git-Bash on Windows), which silently
# turned the whole hook into a no-op. See #1084.
FILE_PATH=$(printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).tool_input?.file_path??""))}catch{}})' 2>/dev/null)

[ -z "$FILE_PATH" ] && exit 0
[ ! -f "$FILE_PATH" ] && exit 0

case "$FILE_PATH" in
    *.ts|*.tsx|*.js|*.jsx|*.css)
        npx prettier --write "$FILE_PATH" &>/dev/null
        ;;
    *.md)
        npx prettier --write "$FILE_PATH" &>/dev/null
        npx markdownlint-cli2 --fix "$FILE_PATH" &>/dev/null
        ;;
    *.rs)
        rustfmt "$FILE_PATH" &>/dev/null
        ;;
esac

# Refresh tests/system/testid-catalog.md when a component's testid set may have
# changed, so the local reference stays current as you edit (#1084, #899). The
# catalog is git-ignored and CI regenerates it from source rather than diffing a
# committed copy (#1528), so this only keeps the local artifact fresh — it is not
# a CI gate. The Node helper self-gates on path + contents (no-op for non-source
# / testid-free files), shells out to build-testid-catalog.py (the single source
# of truth for catalog content), and locates a usable Python interpreter itself.
# Best-effort: never fail the edit.
case "$FILE_PATH" in
    *.ts|*.tsx)
        node "$(dirname "$0")/regen-testid-catalog.mjs" "$FILE_PATH" &>/dev/null || true
        ;;
esac

exit 0
