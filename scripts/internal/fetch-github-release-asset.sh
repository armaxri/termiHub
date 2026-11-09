#!/usr/bin/env bash
# Download one GitHub release asset, authenticated when a token is set (#5105).
#
# Pinned tools (cross-rs, actionlint, shellcheck) come from GitHub releases. An
# anonymous download draws on GitHub's shared anonymous pool, and during the
# 2026-11-09 incident ("increased timeouts due to surge in anonymous users")
# that pool returned 504 even after six attempts. With GH_TOKEN or GITHUB_TOKEN
# set, this script resolves the asset through the REST API and downloads it with
# `Authorization: Bearer`, so the request counts against the token instead:
#   GET api.github.com/repos/<repo>/releases/tags/<tag>   -> the asset's API url
#   GET <asset api url>  (Accept: application/octet-stream) -> 302 -> the bytes
# curl does not forward the Authorization header across the redirect to the
# storage host. The token reaches curl through a config on stdin, never argv.
# Without a token (local runs), or without jq, it uses the anonymous
# github.com/<repo>/releases/download/<tag>/<asset> URL as before.
#
# Every request retries on any error, HTTP 5xx included (--retry-all-errors).
# This script does NOT verify the download: the caller must sha256-check
# <output> against its pin before using it.
#
# Usage: scripts/internal/fetch-github-release-asset.sh <owner/repo> <tag> <asset> <output>
#   e.g. ... koalaman/shellcheck v0.11.0 shellcheck-v0.11.0.linux.x86_64.tar.xz /tmp/sc.tar.xz
set -euo pipefail

case "${1:-}" in
--help | -h)
    awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
    exit 0
    ;;
esac

if [ "$#" -ne 4 ]; then
    echo "usage: $0 <owner/repo> <tag> <asset> <output> (see --help)" >&2
    exit 2
fi
REPO="$1"
TAG="$2"
ASSET="$3"
OUT="$4"

RETRY=(--retry 5 --retry-all-errors --retry-connrefused --retry-delay 5)
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

if [ -z "$TOKEN" ] || ! command -v jq >/dev/null 2>&1; then
    [ -n "$TOKEN" ] && echo "  (jq not found: falling back to an anonymous download)" >&2
    curl -fsSL "${RETRY[@]}" -o "$OUT" \
        "https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
    exit 0
fi

# authed_curl ARGS...: curl with the token header read from a stdin config.
authed_curl() {
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
        curl --config - -fsSL "${RETRY[@]}" \
            -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}

release_json="$(authed_curl -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/releases/tags/${TAG}")"
asset_url="$(jq -r --arg name "$ASSET" \
    '.assets[] | select(.name == $name) | .url' <<<"$release_json")"
if [ -z "$asset_url" ]; then
    echo "ERROR: release ${REPO}@${TAG} has no asset named ${ASSET}" >&2
    exit 1
fi
authed_curl -H "Accept: application/octet-stream" -o "$OUT" "$asset_url"
