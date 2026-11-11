#!/usr/bin/env bash
# Keep the runner's apt sources working when *.ubuntu.com is unreachable (#5385).
#
# GitHub's Ubuntu images route every Ubuntu source (including -security) through
# `mirror+file:/etc/apt/apt-mirrors.txt`, which lists azure.archive.ubuntu.com,
# archive.ubuntu.com and security.ubuntu.com. All three are *.ubuntu.com, so one
# DNS outage for that domain (2026-11-11, `Temporary failure resolving`) fails
# every apt-get in CI, and apt waits ~20 s per index file per mirror before it
# gives up. This script:
#
#   1. makes sure the Ubuntu sources go through a mirror list (images without
#      apt-mirrors.txt get one, and their *.ubuntu.com URIs are pointed at it);
#   2. probes each listed mirror plus independent fallback mirrors outside
#      ubuntu.com (every full Ubuntu mirror also carries the -security pocket;
#      the InRelease files they serve are the same ones signed by Ubuntu, so apt
#      still verifies them against the Ubuntu archive keyring);
#   3. rewrites the list to the reachable mirrors only, the image's own first;
#   4. fails loudly with `::error title=APT mirrors unreachable::` when no mirror
#      answers after a few rounds, instead of letting apt fail later and vaguely.
#
# Environment (defaults are the real runner paths; overrides exist so the
# script can be exercised against a scratch dir):
#   APT_ETC           apt config dir                (/etc/apt)
#   OS_RELEASE        os-release file               (/etc/os-release)
#   APT_ARCH          dpkg architecture             (dpkg --print-architecture)
#   APT_PROBE_ROUNDS  probe rounds before giving up (3)
#   APT_PROBE_SLEEP   seconds between rounds        (10)
set -euo pipefail

APT_ETC="${APT_ETC:-/etc/apt}"
OS_RELEASE="${OS_RELEASE:-/etc/os-release}"
APT_ARCH="${APT_ARCH:-$(dpkg --print-architecture)}"
APT_PROBE_ROUNDS="${APT_PROBE_ROUNDS:-3}"
APT_PROBE_SLEEP="${APT_PROBE_SLEEP:-10}"

MIRRORS_FILE="$APT_ETC/apt-mirrors.txt"
MIRROR_URI="mirror+file:$MIRRORS_FILE"

codename="$(sed -n 's/^VERSION_CODENAME=["'\'']\{0,1\}\([A-Za-z0-9]*\).*/\1/p' "$OS_RELEASE" | head -n1)"
if [ -z "$codename" ]; then
  echo "::warning title=APT mirror fallback::no VERSION_CODENAME in $OS_RELEASE; skipping"
  exit 0
fi

# amd64/i386 live on the main archive; every other architecture on ubuntu-ports.
case "$APT_ARCH" in
  amd64 | i386)
    archive_path="ubuntu"
    fallbacks=(
      "https://mirrors.edge.kernel.org/ubuntu/"
      "https://ftp.halifax.rwth-aachen.de/ubuntu/"
      "https://mirror.math.princeton.edu/pub/ubuntu/"
      "https://mirrors.mit.edu/ubuntu/"
    )
    ;;
  *)
    archive_path="ubuntu-ports"
    fallbacks=(
      "https://mirrors.mit.edu/ubuntu-ports/"
      "https://mirrors.ocf.berkeley.edu/ubuntu-ports/"
      "https://mirror.us.leaseweb.net/ubuntu-ports/"
    )
    ;;
esac

# A source URI this script reroutes: http(s)://<anything>.ubuntu.com/<archive_path>[/],
# ending at whitespace or end of line (so /ubuntu never matches /ubuntu-ports).
ubuntu_uri_re="https?://([A-Za-z0-9-]+\.)*ubuntu\.com/${archive_path}/?([[:space:]]|$)"

source_files=()
for f in "$APT_ETC/sources.list" "$APT_ETC"/sources.list.d/*.sources "$APT_ETC"/sources.list.d/*.list; do
  [ -f "$f" ] && source_files+=("$f")
done

# 1. The image's own mirrors, in their listed order.
primaries=()
if [ -f "$MIRRORS_FILE" ]; then
  while IFS= read -r line; do
    url="${line%%[[:space:]]*}"
    [ -n "$url" ] && [ "${url:0:1}" != "#" ] && primaries+=("$url")
  done <"$MIRRORS_FILE"
fi
if [ "${#source_files[@]}" -gt 0 ]; then
  # Ubuntu URIs that do not go through the list yet (images without
  # apt-mirrors.txt, or a stanza the image left pointing at a host directly).
  while IFS= read -r url; do
    url="${url%%[[:space:]]*}"
    primaries+=("${url%/}/")
  done < <(grep -hoE "$ubuntu_uri_re" "${source_files[@]}" | awk '!seen[$0]++')
fi

if [ "${#primaries[@]}" -eq 0 ]; then
  echo "No Ubuntu archive source found under $APT_ETC; nothing to reroute."
  exit 0
fi

# De-duplicate, keeping the first occurrence.
dedupe() { awk '!seen[$0]++'; }
mapfile -t primaries < <(printf '%s\n' "${primaries[@]}" | dedupe)
mapfile -t fallbacks < <(printf '%s\n' "${fallbacks[@]}" | grep -vxF -f <(printf '%s\n' "${primaries[@]}") || true)

probe() {
  curl -fsSIL --connect-timeout 5 --max-time 10 -o /dev/null "${1%/}/dists/${codename}/InRelease"
}

# 2./3. Probe; keep every reachable primary plus up to two reachable fallbacks.
reachable=()
dropped=()
for round in $(seq 1 "$APT_PROBE_ROUNDS"); do
  reachable=()
  dropped=()
  for url in "${primaries[@]}"; do
    if probe "$url"; then reachable+=("$url"); else dropped+=("$url"); fi
  done
  spare=0
  for url in "${fallbacks[@]}"; do
    [ "$spare" -ge 2 ] && break
    if probe "$url"; then
      reachable+=("$url")
      spare=$((spare + 1))
    fi
  done
  [ "${#reachable[@]}" -gt 0 ] && break
  if [ "$round" -lt "$APT_PROBE_ROUNDS" ]; then
    echo "No Ubuntu mirror answered (round $round/$APT_PROBE_ROUNDS); retrying in ${APT_PROBE_SLEEP}s."
    sleep "$APT_PROBE_SLEEP"
  fi
done

if [ "${#reachable[@]}" -eq 0 ]; then
  tried="$(printf '%s ' "${primaries[@]}" "${fallbacks[@]}")"
  echo "::error title=APT mirrors unreachable::No Ubuntu archive mirror answered for" \
    "'${codename}' after ${APT_PROBE_ROUNDS} rounds (tried: ${tried% }). This is a" \
    "network/DNS outage between the runner and the Ubuntu mirrors, not a code problem;" \
    "re-run the job once it clears (#5385)."
  exit 1
fi

if [ "${#dropped[@]}" -gt 0 ]; then
  echo "::warning title=APT mirror fallback::unreachable, removed from the apt mirror" \
    "list: $(printf '%s ' "${dropped[@]}")(#5385)"
fi

# Write the list: lower priority number = tried first.
tmp="$(mktemp)"
i=1
for url in "${reachable[@]}"; do
  printf '%s\tpriority:%d\n' "$url" "$i" >>"$tmp"
  i=$((i + 1))
done
install -m 0644 "$tmp" "$MIRRORS_FILE"
rm -f "$tmp"

# Point any direct *.ubuntu.com URI at the list (security stanzas included).
for f in "${source_files[@]}"; do
  if grep -qE "$ubuntu_uri_re" "$f"; then
    sed -E -i.bak "s#${ubuntu_uri_re}#${MIRROR_URI}\\2#g" "$f"
    rm -f "$f.bak"
  fi
done

echo "apt mirror list ($MIRRORS_FILE):"
cat "$MIRRORS_FILE"
