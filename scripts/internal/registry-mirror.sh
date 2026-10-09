#!/usr/bin/env bash
#
# Docker Hub resilience for the container-fixture CI jobs (#4614).
#
# The fixture jobs used to pull every base image from Docker Hub
# unauthenticated, so a busy day hit the per-IP pull limit on shared runners
# ("toomanyrequests") and a Docker Hub hiccup ("Requesting bearer token:
# invalid status code from registry 500") redded unrelated PRs. This helper
# removes both failure modes without a repo secret:
#
#   configure       Point the Docker daemon (registry-mirrors in daemon.json)
#                   and rootless Podman (a registries.conf.d drop-in) at the
#                   mirror.gcr.io Docker Hub mirror, then restart Docker and
#                   verify it picked the mirror up. A miss on the mirror falls
#                   back to Docker Hub inside the daemon, so nothing can get
#                   worse than before. Linux CI only (writes /etc, needs sudo).
#   pull IMAGE...   Pull each image, retrying with exponential backoff on a
#                   transient registry error. Uses $CONTAINER_CMD (default
#                   docker), so `CONTAINER_CMD=podman` pre-pulls into Podman.
#                   Short names are qualified to docker.io/library/... so a
#                   non-interactive Podman never hits short-name resolution.
#   fixture-images  Print the base images the tests/docker fixtures build FROM
#                   (plus compose `image:` refs), one per line, for `pull`.
#
# Called by the .github/actions/docker-hub-mirror composite action and by
# tests/docker/polkit/run.sh. Documented in docs/testing.md
# ("Docker Hub resilience in CI").
#
# Usage:
#   scripts/internal/registry-mirror.sh configure [--mirror URL]
#       [--daemon-json PATH] [--podman-conf PATH] [--no-restart]
#   scripts/internal/registry-mirror.sh pull IMAGE...
#   scripts/internal/registry-mirror.sh fixture-images
#
# Environment:
#   CONTAINER_CMD          container CLI for `pull` (default: docker)
#   PULL_ATTEMPTS          attempts per image (default: 4)
#   PULL_BACKOFF_SECONDS   first retry delay, doubled each retry (default: 10)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEFAULT_MIRROR="https://mirror.gcr.io"
DEFAULT_DAEMON_JSON="/etc/docker/daemon.json"
DEFAULT_PODMAN_CONF="/etc/containers/registries.conf.d/99-termihub-docker-hub-mirror.conf"

usage() {
    sed -n '/^# Usage:/,/^# *PULL_BACKOFF_SECONDS/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

warn() { echo "::warning::registry-mirror: $*" >&2; }
err() { echo "::error::registry-mirror: $*" >&2; }

# Run a command with sudo when the target is not writable by us (CI writes
# /etc; the headless self-test writes temp files and needs no sudo).
maybe_sudo() { # <path> <command...>
    local path="$1"
    shift
    local dir
    dir="$(dirname "$path")"
    if { [ -e "$path" ] && [ -w "$path" ]; } || { [ ! -e "$path" ] && [ -d "$dir" ] && [ -w "$dir" ]; }; then
        "$@"
    else
        sudo "$@"
    fi
}

# Write stdin to <path>, creating its directory, with sudo when needed.
write_file() { # <path>
    local path="$1" dir
    dir="$(dirname "$path")"
    if [ ! -d "$dir" ]; then
        if [ -w "$(dirname "$dir")" ]; then mkdir -p "$dir"; else sudo mkdir -p "$dir"; fi
    fi
    maybe_sudo "$path" tee "$path" >/dev/null
}

wait_for_docker() { # <seconds>
    local i
    for ((i = 0; i < $1; i++)); do
        if docker info >/dev/null 2>&1; then return 0; fi
        sleep 1
    done
    return 1
}

configure_docker() { # <mirror> <daemon.json> <restart 0|1>
    local mirror="$1" daemon_json="$2" restart="$3" current merged backup=""
    if ! command -v jq >/dev/null 2>&1; then
        warn "jq not found; Docker keeps pulling from Docker Hub directly"
        return 0
    fi
    if [ -s "$daemon_json" ]; then
        current="$(maybe_sudo "$daemon_json" cat "$daemon_json")"
        backup="$current"
    else
        current="{}"
    fi
    if ! merged="$(jq --arg m "$mirror" \
        '.["registry-mirrors"] = (((.["registry-mirrors"] // []) + [$m]) | unique)' \
        <<<"$current")"; then
        warn "$daemon_json is not valid JSON; leaving it untouched"
        return 0
    fi
    printf '%s\n' "$merged" | write_file "$daemon_json"
    echo "registry-mirror: $daemon_json now lists $mirror under registry-mirrors"

    if [ "$restart" -eq 0 ]; then return 0; fi
    sudo systemctl restart docker
    if ! wait_for_docker 60; then
        # Never leave the job without a daemon: restore the original config.
        warn "Docker did not come back with the mirror config; restoring $daemon_json"
        if [ -n "$backup" ]; then
            printf '%s\n' "$backup" | write_file "$daemon_json"
        else
            maybe_sudo "$daemon_json" rm -f "$daemon_json"
        fi
        sudo systemctl restart docker
        if ! wait_for_docker 60; then
            err "Docker daemon is not reachable after restoring $daemon_json"
            return 1
        fi
        return 0
    fi
    if docker info --format '{{json .RegistryConfig.Mirrors}}' | grep -qF "${mirror#https://}"; then
        echo "registry-mirror: Docker daemon pulls Docker Hub images through $mirror"
    else
        warn "Docker restarted but does not report $mirror as a registry mirror"
    fi
}

configure_podman() { # <mirror> <drop-in path> <explicit 0|1>
    local mirror="$1" conf="$2" explicit="$3" host
    if [ "$explicit" -eq 0 ] && ! command -v podman >/dev/null 2>&1; then
        echo "registry-mirror: podman not installed; skipping its registries.conf drop-in"
        return 0
    fi
    host="${mirror#https://}"
    host="${host#http://}"
    host="${host%/}"
    write_file "$conf" <<EOF
# Written by scripts/internal/registry-mirror.sh (#4614): pull Docker Hub images
# through the $host mirror; Podman falls back to docker.io on a miss.
[[registry]]
prefix = "docker.io"
location = "docker.io"

[[registry.mirror]]
location = "$host"
EOF
    echo "registry-mirror: $conf points Podman's docker.io at $host"
    if [ "$explicit" -eq 0 ]; then
        if podman info --format '{{json .Registries}}' 2>/dev/null | grep -qF "$host"; then
            echo "registry-mirror: Podman pulls Docker Hub images through $host"
        else
            warn "Podman does not report $host as a docker.io mirror"
        fi
    fi
}

cmd_configure() {
    local mirror="$DEFAULT_MIRROR" daemon_json="$DEFAULT_DAEMON_JSON"
    local podman_conf="$DEFAULT_PODMAN_CONF" podman_explicit=0 restart=1
    while [ $# -gt 0 ]; do
        case "$1" in
            --mirror)
                mirror="${2:?--mirror needs a URL}"
                shift 2
                ;;
            --daemon-json)
                daemon_json="${2:?--daemon-json needs a path}"
                shift 2
                ;;
            --podman-conf)
                podman_conf="${2:?--podman-conf needs a path}"
                podman_explicit=1
                shift 2
                ;;
            --no-restart)
                restart=0
                shift
                ;;
            *)
                err "unknown configure option: $1"
                exit 64
                ;;
        esac
    done
    configure_docker "$mirror" "$daemon_json" "$restart"
    configure_podman "$mirror" "$podman_conf" "$podman_explicit"
}

# Fully qualify a Docker Hub short name: alpine:3 -> docker.io/library/alpine:3.
qualify() { # <image>
    local image="$1" first="${1%%/*}"
    if [[ "$image" != */* ]]; then
        echo "docker.io/library/$image"
    elif [[ "$first" == *.* || "$first" == *:* || "$first" == localhost ]]; then
        echo "$image"
    else
        echo "docker.io/$image"
    fi
}

cmd_pull() {
    if [ $# -eq 0 ]; then
        err "pull needs at least one image"
        exit 64
    fi
    local cmd="${CONTAINER_CMD:-docker}" attempts="${PULL_ATTEMPTS:-4}"
    local backoff="${PULL_BACKOFF_SECONDS:-10}" failed=0 image ref n delay
    for image in "$@"; do
        ref="$(qualify "$image")"
        n=1
        delay="$backoff"
        until "$cmd" pull "$ref"; do
            if [ "$n" -ge "$attempts" ]; then
                err "could not pull $ref after $attempts attempts (registry outage or pull limit?)"
                failed=$((failed + 1))
                break
            fi
            warn "pull $ref failed (attempt $n/$attempts); retrying in ${delay}s"
            sleep "$delay"
            delay=$((delay * 2))
            n=$((n + 1))
        done
    done
    [ "$failed" -eq 0 ]
}

cmd_fixture_images() {
    cd "$REPO_ROOT"
    {
        # `FROM <ref> [AS name]`: stage references (`FROM agent`) carry no tag
        # and build args (`FROM ${X}`) cannot be resolved here, so only tagged
        # or digested literal refs are listed.
        find tests/docker -type f -name 'Dockerfile*' -print0 |
            xargs -0 awk 'toupper($1) == "FROM" {
                ref = $2; i = 2
                while (ref ~ /^--/) { i++; ref = $i }
                print ref
            }'
        awk '$1 == "image:" { print $2 }' tests/docker/docker-compose.yml
    } | tr -d '"'"'" | grep -E '[:@]' | grep -v '\$' | sort -u
}

case "${1:-}" in
    -h | --help)
        usage
        ;;
    configure)
        shift
        cmd_configure "$@"
        ;;
    pull)
        shift
        cmd_pull "$@"
        ;;
    fixture-images)
        cmd_fixture_images
        ;;
    *)
        usage >&2
        exit 64
        ;;
esac
