#!/usr/bin/env bash
# Headless integration test for the real polkit D-Bus path of the Linux OS
# re-auth verifier (#3553).
#
# 1. Builds `termihub-polkit-probe` (termiHub's shipped polkit transport,
#    compiled by path) for Linux inside a rust:<pinned>-slim-trixie container,
#    so it runs the same way from macOS, Windows or Linux.
# 2. Builds the tests/docker/polkit image (system bus + polkitd + pkttyagent).
# 3. Runs scenarios.sh in it with the probe and the shipped policy file
#    (src-tauri/packaging/linux/com.termihub.app.policy) mounted read-only.
#
# Usage: tests/docker/polkit/run.sh [--clean]
#   --clean   also remove the image and the cargo cache volumes afterwards
#             (CI; locally the volumes keep the next run incremental).
#
# Names are prefixed with this checkout's TERMIHUB_TEST_PROJECT (from
# dev.local.json) so parallel checkouts never share a container or volume.
set -euo pipefail

clean=0
case "${1:-}" in
    "") ;;
    --clean) clean=1 ;;
    *)
        echo "usage: $0 [--clean]" >&2
        exit 64
        ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"
# shellcheck source=../../../scripts/internal/dev-local-env.sh
source scripts/internal/dev-local-env.sh

docker="${CONTAINER_CMD:-docker}"
prefix="${TERMIHUB_TEST_PROJECT}-polkit"
rust_version="$(tr -d '[:space:]' <.github/rust-version)"
builder_image="rust:${rust_version}-slim-trixie"
fixture_image="${prefix}-fixture"
target_volume="${prefix}-target"
registry_volume="${prefix}-cargo-registry"
container="${prefix}-run"

cleanup() {
    "$docker" rm -f "$container" >/dev/null 2>&1 || true
    if ((clean)); then
        "$docker" image rm -f "$fixture_image" >/dev/null 2>&1 || true
        "$docker" volume rm -f "$target_volume" "$registry_volume" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

echo "== building polkit-probe for Linux in ${builder_image}"
"$docker" run --rm \
    -v "$root":/src:ro \
    -v "$target_volume":/target \
    -v "$registry_volume":/usr/local/cargo/registry \
    -e CARGO_TARGET_DIR=/target \
    -w /src \
    "$builder_image" \
    cargo build --locked -p termihub-polkit-probe

echo "== building the polkit fixture image"
"$docker" build -t "$fixture_image" tests/docker/polkit

echo "== running the polkit scenarios"
"$docker" run --rm --name "$container" \
    -v "$target_volume":/target:ro \
    -v "$root/src-tauri/packaging/linux/com.termihub.app.policy":/fixture/policy/com.termihub.app.policy:ro \
    -e POLKIT_PROBE=/target/debug/polkit-probe \
    -e POLKIT_POLICY=/fixture/policy/com.termihub.app.policy \
    "$fixture_image"
