#!/usr/bin/env bash
#
# Apply the committed branch protection to GitHub (audit finding CI-017, #3675).
#
# Reads .github/branch-protection.json, shows the current drift for the branch
# and the exact REST PUT body, and -- only with --apply -- writes it with
# `gh api -X PUT repos/<repo>/branches/<branch>/protection`. Run manually by a
# repository ADMIN; CI never runs this (the weekly Branch Protection Drift
# workflow only reads).
#
# Usage:
#   scripts/internal/apply-branch-protection.sh --branch <name> [--apply]
#                                               [--repo <owner/name>]
#
# Options:
#   --branch <name>   Branch to apply (must be listed in branch-protection.json).
#   --apply           Actually write the protection. Without it this is a DRY
#                     RUN: it only reads (drift report + payload) and changes
#                     nothing.
#   --repo <o/n>      Repository (default: armaxri/termiHub).
#   --help, -h        Show this help.
#
# After applying a branch whose status is "proposed", change its status to
# "enforced" in .github/branch-protection.json (in a PR) so drift on it fails.
#
# Requires: Node 22+, and an authenticated `gh` CLI (admin rights on the repo to
# read the drift report and for --apply).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CHECK="$SCRIPT_DIR/check-branch-protection.mjs"
EXPECTED="$REPO_ROOT/.github/branch-protection.json"

REPO="armaxri/termiHub"
BRANCH=""
APPLY=false

usage() {
    sed -n '3,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "apply-branch-protection: $*" >&2
    exit 1
}

while [ "$#" -gt 0 ]; do
    case "$1" in
    --branch)
        [ "$#" -ge 2 ] || die "--branch needs a value"
        BRANCH="$2"
        shift 2
        ;;
    --repo)
        [ "$#" -ge 2 ] || die "--repo needs a value"
        REPO="$2"
        shift 2
        ;;
    --apply)
        APPLY=true
        shift
        ;;
    --help | -h)
        usage
        exit 0
        ;;
    *)
        die "unknown argument: $1 (see --help)"
        ;;
    esac
done

[ -n "$BRANCH" ] || die "--branch is required (see --help)"
command -v node >/dev/null 2>&1 || die "node is required"
command -v gh >/dev/null 2>&1 || die "the gh CLI is required"

# Status ("enforced" / "proposed") and required_signatures of the branch in the
# expectation file, as two lines.
BRANCH_INFO="$(node - "$EXPECTED" "$BRANCH" <<'JS'
const [file, branch] = process.argv.slice(2);
const entry = JSON.parse(require("fs").readFileSync(file, "utf8")).branches?.[branch];
if (!entry) {
  console.error(`branch "${branch}" is not in ${file}`);
  process.exit(1);
}
console.log(entry.status);
console.log(entry.protection.required_signatures);
JS
)" || exit 1
STATUS="$(sed -n 1p <<<"$BRANCH_INFO")"
REQUIRE_SIGNATURES="$(sed -n 2p <<<"$BRANCH_INFO")"

PAYLOAD_FILE="$(mktemp)"
trap 'rm -f "$PAYLOAD_FILE"' EXIT
node "$CHECK" --payload "$BRANCH" >"$PAYLOAD_FILE"

PUT=(gh api -X PUT "repos/$REPO/branches/$BRANCH/protection"
    -H "Accept: application/vnd.github+json" --input "$PAYLOAD_FILE")
SIG_PATH="repos/$REPO/branches/$BRANCH/protection/required_signatures"

echo "== Branch protection for $REPO:$BRANCH (status in the repo: $STATUS)"
echo
echo "-- Current drift (read-only):"
# Exit 1 = drift on an enforced branch; that is the thing being fixed here.
drift_rc=0
node "$CHECK" --repo "$REPO" --branch "$BRANCH" || drift_rc=$?
[ "$drift_rc" -le 1 ] || die "could not read the live protection (see above)"
echo
echo "-- PUT body (.github/branch-protection.json -> REST):"
cat "$PAYLOAD_FILE"
echo

if [ "$APPLY" != true ]; then
    echo "-- DRY RUN: nothing was changed. Would run:"
    echo "   gh api -X PUT repos/$REPO/branches/$BRANCH/protection --input <the PUT body above>"
    if [ "$REQUIRE_SIGNATURES" = true ]; then
        echo "   gh api -X POST $SIG_PATH"
    else
        echo "   gh api -X DELETE $SIG_PATH   (only if signatures are required live)"
    fi
    echo "   Re-run with --apply to write it (repository admin only)."
    exit 0
fi

echo "-- Applying ..."
"${PUT[@]}" >/dev/null
if [ "$REQUIRE_SIGNATURES" = true ]; then
    gh api -X POST "$SIG_PATH" >/dev/null
elif [ "$(gh api "$SIG_PATH" --jq .enabled)" = true ]; then
    gh api -X DELETE "$SIG_PATH" >/dev/null
fi

echo "-- Verifying:"
node "$CHECK" --repo "$REPO" --branch "$BRANCH"
if [ "$STATUS" = proposed ]; then
    echo
    echo "Applied. Now set branches.$BRANCH.status to \"enforced\" in"
    echo ".github/branch-protection.json (via a PR) so the weekly check fails on drift."
fi
