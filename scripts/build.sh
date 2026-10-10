#!/usr/bin/env bash
# Build the app for production (creates platform installer).
# On macOS also cross-compiles the remote agent for Linux x86_64 + aarch64.
# Run from anywhere: ./scripts/build.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ ! -d node_modules ]; then
    echo "node_modules missing, running pnpm install..."
    pnpm install
    echo ""
fi

# The RDP sidecar (#1747) ships next to the desktop binary via Tauri
# `externalBin` (#1754). `externalBin` is declared in a bundle-only config
# fragment (tauri.sidecar.conf.json) rather than the base config, so per-PR
# compile/test/clippy jobs — which never bundle — don't need the helper built.
# Here we do bundle, so build+stage the host sidecar first (tauri-build rejects
# a missing externalBin), then merge the fragment via `--config`.
echo "=== Building RDP sidecar for bundling ==="
"$(dirname "$0")/build-rdp-sidecar.sh" --release --tauri-externalbin

# The plugin runner (#4182) is the second externalBin in the same fragment
# (#4202): build and stage it too. core/build.rs embeds its SHA-256, which the
# app checks before spawning the bundled runner.
echo "=== Building plugin runner for bundling ==="
"$(dirname "$0")/build-plugin-runner.sh" --release --tauri-externalbin

# Third-party license notices (PKG-009): bundled as an app resource via the
# tauri.notices.conf.json fragment when the pinned cargo-about is installed
# (release.yml always generates them). Without it the build still succeeds;
# About -> Third-Party Licenses then points to the online attribution page.
tauri_configs=(--config src-tauri/tauri.sidecar.conf.json)
if command -v cargo-about >/dev/null 2>&1; then
    echo "=== Generating third-party notices ==="
    pnpm notices:generate
    tauri_configs+=(--config src-tauri/tauri.notices.conf.json)
else
    echo "cargo-about not found: skipping bundled third-party notices"
    echo "  (install: cargo install cargo-about --locked --version 0.9.2)"
fi

# Windows (Git Bash): bundle the sideloaded ConPTY host next to termihub.exe
# (#4121) -- the inbox ConPTY strips inline images. Fetched at the pinned
# version and SHA-256-verified; a mismatch or failed download stops the build.
case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*)
    "$(dirname "$0")/internal/fetch-conpty.sh"
    tauri_configs+=(--config src-tauri/tauri.conpty.conf.json)
    ;;
esac

echo "Building termiHub for production..."
pnpm tauri build "${tauri_configs[@]}"

# --- Cross-compile agent binaries for Linux (macOS only) ---
#
# termiHub connects to remote hosts (Raspberry Pi, servers) that need the
# agent binary.  Building both architectures alongside the desktop app
# means users always have matching binaries ready for upload.
#
# Prerequisites (one-time):
#   brew install filosottile/musl-cross/musl-cross                              # x86_64
#   brew install messense/macos-cross-toolchains/aarch64-unknown-linux-musl     # aarch64
#   rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl

if [ "$(uname -s)" = "Darwin" ]; then
    echo ""
    echo "=== Building agent binaries for Linux ==="
    agent_built=0
    agent_failed=0

    for target in aarch64-unknown-linux-musl x86_64-unknown-linux-musl; do
        arch="${target%%-*}"   # aarch64 or x86_64
        linker="${arch}-linux-musl-gcc"

        if ! command -v "$linker" >/dev/null 2>&1; then
            echo "  Skipping $target: $linker not found"
            continue
        fi

        if ! rustup target list --installed | grep -q "$target"; then
            echo "  Adding Rust target $target..."
            rustup target add "$target"
        fi

        echo "  Building agent for $target..."
        linker_env="CARGO_TARGET_$(echo "$target" | tr '[:lower:]' '[:upper:]' | tr '-' '_')_LINKER"
        env "$linker_env=$linker" \
            cargo build --release --target "$target" -p termihub-agent

        # A release agent without the test-hooks feature: it must embed neither
        # the TEST-ONLY update-signing key (#4083) nor the env-armed test hooks
        # (#4362), since this is the path developers upload (#4554). Same guards
        # as build-agents.sh and CI (agent.yml, release.yml).
        binary="target/$target/release/termihub-agent"
        if ! scripts/internal/assert-no-test-signing-key.sh "$binary" ||
            ! scripts/internal/assert-no-agent-test-hooks.sh "$binary"; then
            echo "  FAILED: $binary embeds test-only artifacts and must never be uploaded"
            agent_failed=$((agent_failed + 1))
            continue
        fi

        echo "  -> $binary"
        agent_built=$((agent_built + 1))
    done

    if [ "$agent_failed" -gt 0 ]; then
        echo ""
        echo "ERROR: $agent_failed agent binary(ies) failed the test-only artifact guard."
        exit 1
    fi

    if [ "$agent_built" -eq 0 ]; then
        echo ""
        echo "  No agent binaries were built — cross-compilation toolchains not found."
        echo "  Install them with:"
        echo "    brew install filosottile/musl-cross/musl-cross"
        echo "    brew install messense/macos-cross-toolchains/aarch64-unknown-linux-musl"
        echo "    rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl"
    fi
fi
