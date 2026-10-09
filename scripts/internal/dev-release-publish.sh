#!/usr/bin/env bash
#
# Failure-safe publisher for the rolling dev releases (#4471).
#
# dev-build.yml republishes `dev-latest` (main) / `dev-<branch>-latest`
# (develop) on every push. It used to delete the release first and then create
# it from whatever artifacts existed, so a run whose builds all failed left an
# EMPTY release page (run 37898730852). This helper is the only code that
# mutates the release, and it only runs after every build job succeeded.
#
# Subcommands:
#   check-artifacts <dir>     Fail (exit 1, one ::error per file) unless every
#                             required dev artifact is in <dir>: the primary
#                             installer per desktop platform and every agent
#                             binary. The best-effort secondary bundles
#                             (…-setup.exe, linux-x64 .deb, linux-arm64 .rpm) are
#                             not required.
#   publish --tag <tag> --sha <sha> --dir <dir> --title <title> --notes <file>
#                             Replace release <tag> with the files in <dir>.
#
# How `publish` keeps the previous assets until the new ones are complete:
#   1. Stage: create a DRAFT release under a unique staging tag
#      (<tag>-staging-<run id>) holding every file in <dir>. Drafts create no
#      git tag and are invisible to downloads, so the live release is untouched.
#   2. Verify: the draft's uploaded asset names must equal the files in <dir>.
#      Any failure in steps 1-2 deletes the draft and exits 1; the previous
#      release and all of its assets are still in place.
#   3. Swap: delete the old release and its tag, then publish the draft under
#      <tag> at <sha> (retried). Only these two back-to-back API calls are
#      the window in which <tag> has no release. If publishing still fails, the
#      complete draft is kept and the recovery command is printed.
#   4. Tidy: delete stale staging drafts of <tag> left by cancelled runs.
#
# Requires an authenticated `gh` (GH_REPO selects the repository; `gh api`
# fills {owner}/{repo} from it). GITHUB_RUN_ID names the draft (default: PID).
# Environment knobs (tests): DEV_RELEASE_PUBLISH_RETRIES (default 3),
# DEV_RELEASE_PUBLISH_BACKOFF (seconds, default 5).

set -euo pipefail

usage() {
  sed -n '3,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "dev-release-publish: $*" >&2
  exit 1
}

# Artifacts guaranteed to exist when their build leg succeeds: <file>|<label>.
EXPECTED=(
  "termiHub-dev-macos-x64.dmg|macOS Intel (.dmg)"
  "termiHub-dev-macos-arm64.dmg|macOS Apple Silicon (.dmg)"
  "termiHub-dev-windows-x64.msi|Windows x64 (.msi)"
  "termiHub-dev-linux-x64.AppImage|Linux x64 (.AppImage)"
  "termiHub-dev-linux-arm64.deb|Linux ARM64 (.deb)"
  "termihub-agent-linux-x64|Agent Linux x64"
  "termihub-agent-linux-arm64|Agent Linux ARM64"
  "termihub-agent-linux-armv7|Agent Linux ARMv7"
  "termihub-agent-macos-arm64|Agent macOS ARM64"
  "termihub-agent-macos-x64|Agent macOS x64"
  "termihub-agent-windows-x64.exe|Agent Windows x64"
  "termihub-agent-windows-arm64.exe|Agent Windows ARM64"
)

check_artifacts() {
  [ "$#" -eq 1 ] || die "usage: check-artifacts <dir>"
  local dir="$1" entry f label missing=0
  [ -d "$dir" ] || die "artifact directory '$dir' does not exist"
  for entry in "${EXPECTED[@]}"; do
    f="${entry%%|*}"
    label="${entry#*|}"
    if [ ! -f "$dir/$f" ]; then
      echo "::error title=Incomplete dev build::Missing artifact '$f' ($label)."
      missing=$((missing + 1))
    fi
  done
  if [ "$missing" -gt 0 ]; then
    echo "dev-release-publish: $missing required artifact(s) missing; refusing to publish." >&2
    exit 1
  fi
  echo "All ${#EXPECTED[@]} required dev artifacts present."
}

# The id of the draft release whose tag_name is $1 (empty if none).
draft_id() {
  gh api "repos/{owner}/{repo}/releases?per_page=100" \
    --jq ".[] | select(.draft and .tag_name == \"$1\") | .id" | head -n 1
}

publish() {
  local tag="" sha="" dir="" title="" notes=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tag) tag="${2:-}"; shift 2 ;;
      --sha) sha="${2:-}"; shift 2 ;;
      --dir) dir="${2:-}"; shift 2 ;;
      --title) title="${2:-}"; shift 2 ;;
      --notes) notes="${2:-}"; shift 2 ;;
      *) die "publish: unknown argument '$1'" ;;
    esac
  done
  [ -n "$tag" ] && [ -n "$sha" ] && [ -n "$dir" ] && [ -n "$title" ] && [ -n "$notes" ] \
    || die "publish needs --tag, --sha, --dir, --title and --notes"
  [ -f "$notes" ] || die "notes file '$notes' does not exist"

  local files=() expected_names actual_names
  while IFS= read -r -d '' f; do
    files+=("$f")
  done < <(find "$dir" -maxdepth 1 -type f -print0 | sort -z)
  [ "${#files[@]}" -gt 0 ] || die "no files to publish in '$dir'"
  expected_names="$(for f in "${files[@]}"; do basename "$f"; done | sort)"

  local staging="${tag}-staging-${GITHUB_RUN_ID:-$$}"
  local retries="${DEV_RELEASE_PUBLISH_RETRIES:-3}"
  local backoff="${DEV_RELEASE_PUBLISH_BACKOFF:-5}"

  # 1. Stage. A failed create may leave a partial draft behind: drop it.
  echo "Staging ${#files[@]} asset(s) in draft release '$staging'..."
  local id=""
  if ! gh release create "$staging" "${files[@]}" --draft --prerelease \
    --target "$sha" --title "$title" --notes-file "$notes"; then
    id="$(draft_id "$staging" || true)"
    [ -n "$id" ] && gh api -X DELETE "repos/{owner}/{repo}/releases/$id" || true
    die "staging failed; release '$tag' was not touched"
  fi
  id="$(draft_id "$staging")"
  [ -n "$id" ] || die "staged draft '$staging' not found; release '$tag' was not touched"

  # 2. Verify every asset finished uploading before touching the live release.
  actual_names="$(gh api "repos/{owner}/{repo}/releases/$id" \
    --jq '.assets[] | select(.state == "uploaded") | .name' | sort)"
  if [ "$actual_names" != "$expected_names" ]; then
    echo "Expected assets:" >&2
    printf '%s\n' "$expected_names" >&2
    echo "Uploaded assets:" >&2
    printf '%s\n' "$actual_names" >&2
    gh api -X DELETE "repos/{owner}/{repo}/releases/$id" || true
    die "staged draft is incomplete; release '$tag' was not touched"
  fi

  # 3. Swap. Remove the old release and tag; also a lone stale tag, which
  # would otherwise pin the new release to the old commit.
  if gh release view "$tag" --json id >/dev/null 2>&1; then
    gh release delete "$tag" --yes --cleanup-tag \
      || { gh api -X DELETE "repos/{owner}/{repo}/releases/$id" || true
           die "could not delete old release '$tag'; it is still in place"; }
  fi
  gh api -X DELETE "repos/{owner}/{repo}/git/refs/tags/$tag" >/dev/null 2>&1 || true

  local attempt=1
  until gh api -X PATCH "repos/{owner}/{repo}/releases/$id" \
    -f tag_name="$tag" -f target_commitish="$sha" -f name="$title" \
    -F draft=false -F prerelease=true -f make_latest=false >/dev/null; do
    if [ "$attempt" -ge "$retries" ]; then
      echo "::error title=Dev release not published::Release '$tag' was replaced by draft" \
        "$id, which failed to publish. Recover with: gh api -X PATCH" \
        "repos/{owner}/{repo}/releases/$id -f tag_name=$tag -F draft=false"
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep "$backoff"
  done
  echo "Published release '$tag' at $sha with ${#files[@]} asset(s)."

  # 4. Tidy stale staging drafts from cancelled runs (best-effort).
  local stale
  stale="$(gh api "repos/{owner}/{repo}/releases?per_page=100" \
    --jq ".[] | select(.draft and (.tag_name | startswith(\"${tag}-staging-\"))) | .id" \
    || true)"
  for sid in $stale; do
    # Never the release just published (the list may still report it a draft).
    [ "$sid" = "$id" ] && continue
    gh api -X DELETE "repos/{owner}/{repo}/releases/$sid" >/dev/null || true
  done
}

case "${1:-}" in
  -h | --help) usage ;;
  check-artifacts) shift; check_artifacts "$@" ;;
  publish) shift; publish "$@" ;;
  *) usage >&2; exit 2 ;;
esac
