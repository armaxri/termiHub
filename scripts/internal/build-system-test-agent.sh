#!/usr/bin/env bash
# Build the static-musl `termihub-agent` the system-test harness bakes into its
# deployed-agent containers (tests/docker/remote-agent, #995 / #4083).
#
# This is the ONE place that build recipe lives. The harness
# (`stage_remote_agent_binary` in tests/system/termihub_harness/fixtures.py) and
# the nightly system-integration workflow both call it, so the recipe travels
# with the code being graded rather than being copied into the workflow file
# (the scheduled nightly runs main's workflow copy against develop, see #3664).
#
# What the recipe needs, and why:
#   --features test-hooks: compiles in the env-gated pending-update hook the
#       armed containers drive (#1546) and the TEST-ONLY update-signing key the
#       real-swap container signs its staged update with (#4083). Without it the
#       armed suites cannot arm and the real swap fails at AGT-005. The binary
#       is checked for the key after the build (assert-no-test-signing-key.sh,
#       inverted), so a build that silently lost the feature fails here.
#   Linux musl target for the host architecture: the binary runs inside a Linux
#       container of the same arch (no glibc coupling to the image).
#   Its own cargo target dir, target/system-test-agent (#4339): the binary
#       trusts the TEST-ONLY key, so it must never land in target/<triple>/release/,
#       where scripts/build.sh and scripts/build-agents.sh leave the real agents
#       that developers upload. Sharing the path also overwrote those agents.
#
# How it builds, in order:
#   1. The local cross images (localhost/termihub-cross:<target>, made by
#      scripts/setup-agent-cross.sh) exist -> build with agent/Cross.toml, as
#      scripts/build-agents.sh does on the normal local-dev path.
#   2. Otherwise, on a non-x86_64 Linux host building its OWN arch (the
#      linux-arm64 nightly leg on ubuntu-24.04-arm, #4934): a native build in
#      the official Rust Alpine image (native musl, so ring / aws-lc-sys
#      compile with the image's own C toolchain). cross-rs' stock images are
#      linux/amd64 only, so they cannot run on an arm64 host without emulation.
#      The image tag follows .github/rust-version.
#   3. Otherwise `cross build` with cross-rs' stock images (pulled from GHCR),
#      exactly like agent.yml / release.yml build the shipped Linux agents. The
#      custom images only add an lld linker for Windows/Podman hosts.
#   With --install-cross, a missing `cross` is first installed from the pinned,
#   SHA256-verified cross-rs release in .github/cross-version (x86_64 Linux hosts;
#   path 2 needs no cross at all).
#   The harness passes it on CI only: before #4092 the integration lane had no
#   `cross`, so every deployed-agent suite skipped there and never ran.
#
# Usage: scripts/internal/build-system-test-agent.sh [--target <triple>] [--install-cross]
#   --target <triple>   musl target to build (default: the host arch's musl target)
#   --install-cross     install the pinned cross-rs release if `cross` is missing
#
# Prints the built binary's path as its last line. Exit 0 = built and verified.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# The cross-rs pin (version + tarball SHA256) lives only in .github/cross-version,
# shared with the CI setup-cross action (#4360); read lazily by install_cross.
CROSS_PIN_FILE="$REPO_ROOT/.github/cross-version"

usage() {
    sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

TARGET=""
INSTALL_CROSS=false
while [ "$#" -gt 0 ]; do
    case "$1" in
    --target)
        [ "$#" -ge 2 ] || {
            echo "ERROR: --target needs a value" >&2
            exit 2
        }
        TARGET="$2"
        shift 2
        ;;
    --install-cross)
        INSTALL_CROSS=true
        shift
        ;;
    --help | -h)
        usage
        exit 0
        ;;
    *)
        echo "ERROR: unknown option: $1 (see --help)" >&2
        exit 2
        ;;
    esac
done

if [ -z "$TARGET" ]; then
    case "$(uname -m)" in
    x86_64 | amd64) TARGET="x86_64-unknown-linux-musl" ;;
    aarch64 | arm64) TARGET="aarch64-unknown-linux-musl" ;;
    armv7l) TARGET="armv7-unknown-linux-musleabihf" ;;
    *)
        echo "ERROR: no musl agent target for host architecture $(uname -m)" >&2
        exit 1
        ;;
    esac
fi
case "$TARGET" in
*-linux-musl*) ;;
*)
    echo "ERROR: $TARGET is not a Linux musl target" >&2
    exit 2
    ;;
esac

cd "$REPO_ROOT"
# Keep in sync with SYSTEM_TEST_AGENT_TARGET_DIR in tests/system/termihub_harness/fixtures.py.
TARGET_DIR="target/system-test-agent"
BINARY="$TARGET_DIR/$TARGET/release/termihub-agent"

container_cmd() {
    if [ -n "${CROSS_CONTAINER_ENGINE:-}" ]; then
        echo "$CROSS_CONTAINER_ENGINE"
    else
        echo docker
    fi
}

has_local_cross_image() {
    local engine
    engine="$(container_cmd)"
    command -v "$engine" >/dev/null 2>&1 &&
        "$engine" image inspect "localhost/termihub-cross:$TARGET" >/dev/null 2>&1
}

install_cross() {
    if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
        echo "ERROR: --install-cross only knows the x86_64 Linux cross-rs release;" \
            "install cross by hand (scripts/setup-agent-cross.sh)" >&2
        return 1
    fi
    local bin_dir tmp url CROSS_VERSION CROSS_SHA256
    CROSS_VERSION="$(sed -n 's/^version=//p' "$CROSS_PIN_FILE" | tr -d '[:space:]')"
    CROSS_SHA256="$(sed -n 's/^sha256=//p' "$CROSS_PIN_FILE" | tr -d '[:space:]')"
    if ! [[ "$CROSS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
        ! [[ "$CROSS_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
        echo "ERROR: malformed cross-rs pin in $CROSS_PIN_FILE" >&2
        return 1
    fi
    bin_dir="${CARGO_HOME:-$HOME/.cargo}/bin"
    mkdir -p "$bin_dir"
    tmp="$(mktemp -d)"
    url="https://github.com/cross-rs/cross/releases/download/v${CROSS_VERSION}/cross-x86_64-unknown-linux-gnu.tar.gz"
    echo "Installing cross-rs v$CROSS_VERSION into $bin_dir"
    curl -fsSL --retry 3 "$url" -o "$tmp/cross.tar.gz"
    echo "${CROSS_SHA256}  $tmp/cross.tar.gz" | sha256sum -c - >/dev/null
    tar xzf "$tmp/cross.tar.gz" -C "$bin_dir"
    rm -rf "$tmp"
    export PATH="$bin_dir:$PATH"
}

# Path 2: the host's own musl target on a non-x86_64 Linux host (see header).
host_musl_target() {
    case "$(uname -m)" in
    aarch64 | arm64) echo "aarch64-unknown-linux-musl" ;;
    armv7l) echo "armv7-unknown-linux-musleabihf" ;;
    *) echo "" ;;
    esac
}

native_container_build() {
    local engine rust_version image
    engine="$(container_cmd)"
    rust_version="$(tr -d '[:space:]' <"$REPO_ROOT/.github/rust-version")"
    if ! [[ "$rust_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "ERROR: malformed Rust version in .github/rust-version: '$rust_version'" >&2
        return 1
    fi
    image="rust:${rust_version}-alpine"
    echo "Building $TARGET natively in $image ($engine) into $TARGET_DIR"
    mkdir -p "$TARGET_DIR"
    # Runs as root (apk needs it), then hands the outputs back to the caller's
    # uid so a later cargo run on the host can reuse / clean them. CARGO_HOME
    # lives under the target dir so the registry cache survives between runs
    # without writing root-owned files into the host's ~/.cargo.
    # The inner script expands $TARGET/$HOST_UID/... inside the container (they
    # are passed with -e), so it is single-quoted on purpose.
    # shellcheck disable=SC2016
    "$engine" run --rm \
        -v "$REPO_ROOT:/src" -w /src \
        -e CARGO_HOME=/src/$TARGET_DIR/cargo-home \
        -e CARGO_TARGET_DIR=/src/$TARGET_DIR \
        -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
        -e TARGET="$TARGET" \
        "$image" sh -euc '
            apk add --no-cache musl-dev gcc g++ make cmake perl linux-headers >/dev/null
            status=0
            cargo build --release --target "$TARGET" -p termihub-agent \
                --features test-hooks || status=$?
            chown -R "$HOST_UID:$HOST_GID" "$CARGO_TARGET_DIR"
            exit "$status"
        '
}

if [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" != "x86_64" ] &&
    [ "$TARGET" = "$(host_musl_target)" ] && ! has_local_cross_image; then
    if ! command -v "$(container_cmd)" >/dev/null 2>&1; then
        echo "ERROR: $(container_cmd) not found; the native $TARGET build runs in a container" >&2
        exit 1
    fi
    native_container_build
else
    if ! command -v cross >/dev/null 2>&1; then
        if [ "$INSTALL_CROSS" = true ]; then
            install_cross
        fi
        if ! command -v cross >/dev/null 2>&1; then
            echo "ERROR: cross-rs not found. Run ./scripts/setup-agent-cross.sh first" \
                "(or pass --install-cross on an x86_64 Linux host)." >&2
            exit 1
        fi
    fi

    if has_local_cross_image; then
        echo "Building $TARGET with the local cross image (agent/Cross.toml) into $TARGET_DIR"
        CARGO_TARGET_DIR="$TARGET_DIR" CROSS_CONFIG=agent/Cross.toml \
            cross build --release --target "$TARGET" -p termihub-agent --features test-hooks
    else
        echo "Building $TARGET with cross-rs' stock image (no localhost/termihub-cross:$TARGET)" \
            "into $TARGET_DIR"
        # No CROSS_CONFIG: the repo-root workspace has no Cross.toml, so cross uses
        # its stock GHCR image for the target, as agent.yml does.
        env -u CROSS_CONFIG CARGO_TARGET_DIR="$TARGET_DIR" \
            cross build --release --target "$TARGET" -p termihub-agent --features test-hooks
    fi
fi

if [ ! -f "$BINARY" ]; then
    echo "ERROR: build reported success but $BINARY is missing" >&2
    exit 1
fi

# The probe exits 1 when the binary embeds the TEST-ONLY key -- which is exactly
# what a test-hooks build must do here. 0 means the feature was lost; 2 is a
# usage/IO error.
probe_status=0
scripts/internal/assert-no-test-signing-key.sh "$BINARY" >/dev/null 2>&1 || probe_status=$?
case "$probe_status" in
1) ;;
0)
    echo "ERROR: $BINARY does not embed the TEST-ONLY update-signing key —" \
        "it was built without --features test-hooks" >&2
    exit 1
    ;;
*)
    echo "ERROR: could not probe $BINARY for the test signing key (exit $probe_status)" >&2
    exit 1
    ;;
esac

echo "$BINARY"
