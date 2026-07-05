#!/bin/bash
# Auto-format a single file based on its extension, and keep the data-testid
# catalog in sync. Designed to be called by a Claude Code PostToolUse hook.
# Reads JSON from stdin to extract the file path.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

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

# Keep tests/system/testid-catalog.md in sync (#1084). A stale catalog breaks two
# CI jobs ("Frontend Code Quality" catalog check and "System-Test machinery") and
# is easy to forget to regenerate by hand. Regenerate automatically whenever a
# frontend source file that could carry a data-testid changes, so the normal dev
# flow can never leave the catalog stale. The generator is fast (~0.2s, stdlib
# only) and idempotent — it rewrites the file only when the scan actually differs.
#
# Trigger on any edited `src/**` `.tsx` (JSX components — where every data-testid
# lives, so add/change/remove are all caught), plus any other frontend source
# that currently references data-testid. This must never block the hook, so all
# failures are swallowed and we always exit 0.
regenerate_testid_catalog() {
    local script_dir catalog_script python_bin
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    catalog_script="$script_dir/../build-testid-catalog.py"
    [ -f "$catalog_script" ] || return 0

    if command -v python3 &>/dev/null; then
        python_bin=python3
    elif command -v python &>/dev/null; then
        python_bin=python
    else
        return 0
    fi

    "$python_bin" "$catalog_script" &>/dev/null || true
}

case "$FILE_PATH" in
    */src/*.tsx)
        regenerate_testid_catalog
        ;;
    */src/*.ts|*/src/*.jsx|*/src/*.js)
        if grep -q "data-testid" "$FILE_PATH" 2>/dev/null; then
            regenerate_testid_catalog
        fi
        ;;
esac

exit 0
