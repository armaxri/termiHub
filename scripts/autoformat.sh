#!/bin/bash
# Auto-format a single file based on its extension.
# Designed to be called by a Claude Code PostToolUse hook.
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

exit 0
