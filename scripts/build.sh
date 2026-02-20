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

echo "Building termiHub for production..."
pnpm tauri build

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
            cargo build --release --target "$target" --manifest-path agent/Cargo.toml

        echo "  -> agent/target/$target/release/termihub-agent"
        agent_built=$((agent_built + 1))
    done

    if [ "$agent_built" -eq 0 ]; then
        echo ""
        echo "  No agent binaries were built — cross-compilation toolchains not found."
        echo "  Install them with:"
        echo "    brew install filosottile/musl-cross/musl-cross"
        echo "    brew install messense/macos-cross-toolchains/aarch64-unknown-linux-musl"
        echo "    rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl"
    fi
fi
