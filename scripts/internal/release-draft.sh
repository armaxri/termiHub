#!/usr/bin/env bash
#
# Draft-then-publish helper for the tag release (release.yml, PKG2-006, #4361).
#
# release.yml used to create the (pre)release as PUBLISHED before anything was
# built, and the build legs uploaded without --clobber. A leg that uploaded and
# then failed (a later upload, a transient Sigstore error in the attestation)
# could not be finished by "re-run failed jobs" (its upload now failed on
# "already exists"), and the half-populated release was public meanwhile.
# Now create-release makes a DRAFT, every upload uses --clobber, and a final
# publish-release job publishes the draft after verify-release passed.
#
# Subcommands:
#   create --tag <tag> --title <title> --notes <file> [--prerelease]
#       Create <tag>'s release as a draft that is never marked latest. When a
#       DRAFT for <tag> already exists (create-release re-run), update its
#       title, notes and prerelease flag instead, keeping uploaded assets.
#       Refuse (exit 1) when <tag> already has a PUBLISHED release: rebuilding
#       would silently replace public assets.
#   publish --tag <tag>
#       Publish <tag>'s draft release, explicitly NOT as latest (mark-latest
#       promotes a stable release only after the install smokes). A release
#       that is already published is left alone (exit 0), so a re-run of the
#       job is safe. No release for <tag> at all is an error.
#   state --tag <tag>
#       Print "draft", "published" or "none" for <tag>'s release.
#
# Requires an authenticated `gh` whose token has push access (contents:
# write): draft releases are invisible to read-only tokens. GH_REPO selects
# the repository; `gh api` fills {owner}/{repo} from it.
# Environment knobs (tests): RELEASE_DRAFT_RETRIES (default 3),
# RELEASE_DRAFT_BACKOFF (seconds, default 5).

set -euo pipefail

usage() {
  sed -n '3,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "release-draft: $*" >&2
  exit 1
}

# "<id> <draft>" for every release whose tag_name is $1, one per line. Drafts
# are only returned to a token with push access; --paginate walks past the
# first 100 releases.
releases_for_tag() {
  gh api --paginate "repos/{owner}/{repo}/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"$1\") | \"\\(.id) \\(.draft)\""
}

# Sets REL_STATE (none|draft|published) and REL_ID for tag $1. More than one
# release for one tag is ambiguous and fatal (never guess which to publish).
resolve() {
  local tag="$1" lines count
  lines="$(releases_for_tag "$tag")" || die "could not list releases"
  REL_STATE=none
  REL_ID=""
  [ -n "$lines" ] || return 0
  count="$(printf '%s\n' "$lines" | wc -l | tr -d ' ')"
  if [ "$count" -ne 1 ]; then
    printf '%s\n' "$lines" >&2
    die "found $count releases for tag '$tag'; delete the extra draft(s) by hand"
  fi
  REL_ID="${lines%% *}"
  case "${lines#* }" in
    true) REL_STATE=draft ;;
    false) REL_STATE=published ;;
    *) die "unexpected release listing for '$tag': $lines" ;;
  esac
}

cmd_create() {
  local tag="" title="" notes="" prerelease=false
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tag) tag="${2:-}"; shift 2 ;;
      --title) title="${2:-}"; shift 2 ;;
      --notes) notes="${2:-}"; shift 2 ;;
      --prerelease) prerelease=true; shift ;;
      *) die "create: unknown argument '$1'" ;;
    esac
  done
  [ -n "$tag" ] && [ -n "$title" ] && [ -n "$notes" ] \
    || die "create needs --tag, --title and --notes"
  [ -f "$notes" ] || die "notes file '$notes' does not exist"

  resolve "$tag"
  case "$REL_STATE" in
    published)
      echo "::error title=Release already published::${tag} already has a published" \
        "release. Re-running would replace its public assets; delete the release or" \
        "push a new tag."
      exit 1
      ;;
    draft)
      echo "Reusing the existing draft release for ${tag} (id ${REL_ID}); updating its notes."
      gh release edit "$tag" --title "$title" --notes-file "$notes" \
        --prerelease="$prerelease" --draft=true >/dev/null
      ;;
    none)
      local flags=(--draft --latest=false)
      [ "$prerelease" = true ] && flags+=(--prerelease)
      # --verify-tag: never let gh create the tag (it must be the pushed one).
      gh release create "$tag" --verify-tag "${flags[@]}" \
        --title "$title" --notes-file "$notes"
      echo "Created draft release ${tag} (prerelease=${prerelease}, not latest)."
      ;;
  esac
}

cmd_publish() {
  local tag=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tag) tag="${2:-}"; shift 2 ;;
      *) die "publish: unknown argument '$1'" ;;
    esac
  done
  [ -n "$tag" ] || die "publish needs --tag"

  resolve "$tag"
  case "$REL_STATE" in
    none) die "no release exists for '$tag'; nothing to publish" ;;
    published)
      echo "${tag} is already published; nothing to do."
      return 0
      ;;
  esac

  local retries="${RELEASE_DRAFT_RETRIES:-3}"
  local backoff="${RELEASE_DRAFT_BACKOFF:-5}"
  local attempt=1
  # make_latest=false: publishing a draft defaults to "latest" for a stable
  # release; only mark-latest may set it, after the install smokes passed.
  until gh api -X PATCH "repos/{owner}/{repo}/releases/${REL_ID}" \
    -F draft=false -f make_latest=false >/dev/null; do
    if [ "$attempt" -ge "$retries" ]; then
      echo "::error title=Release not published::Draft ${REL_ID} for ${tag} failed to publish." \
        "Recover with: gh api -X PATCH repos/{owner}/{repo}/releases/${REL_ID}" \
        "-F draft=false -f make_latest=false"
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep "$backoff"
  done

  resolve "$tag"
  [ "$REL_STATE" = published ] || die "${tag} is still '${REL_STATE}' after publishing"
  echo "Published ${tag} (not marked latest)."
}

cmd_state() {
  local tag=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tag) tag="${2:-}"; shift 2 ;;
      *) die "state: unknown argument '$1'" ;;
    esac
  done
  [ -n "$tag" ] || die "state needs --tag"
  resolve "$tag"
  echo "$REL_STATE"
}

case "${1:-}" in
  -h | --help) usage ;;
  create) shift; cmd_create "$@" ;;
  publish) shift; cmd_publish "$@" ;;
  state) shift; cmd_state "$@" ;;
  *) usage >&2; exit 2 ;;
esac
