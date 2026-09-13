#!/usr/bin/env bash
# First-time project setup — installs all dependencies.
# Run from anywhere: ./scripts/setup.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "=== Installing frontend dependencies ==="
pnpm install

echo ""
echo "=== Enabling git hooks (pre-commit, commit-msg, pre-push) ==="
# Point git at the committed scripts/hooks directory (git's native mechanism, no
# extra dependency). This is a per-clone setting, so hooks stay opt-in: nothing
# changes until this runs. Bypass any hook with `--no-verify` or TERMIHUB_SKIP_HOOKS=1.
git config core.hooksPath scripts/hooks
echo "Git hooks enabled via core.hooksPath=scripts/hooks."

echo ""
echo "=== Building Rust workspace (first compile takes a while) ==="
cargo build --workspace

echo ""
echo "Setup complete. Run ./scripts/dev.sh to start the app."
