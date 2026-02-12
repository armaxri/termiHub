#!/usr/bin/env bash
#
# Start the Docker test environment and launch TermiHub with test config.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$EXAMPLES_DIR/.." && pwd)"
DOCKER_DIR="$EXAMPLES_DIR/docker"
CONFIG_DIR="$EXAMPLES_DIR/config"

# --- Check prerequisites ---
if ! command -v docker &>/dev/null; then
    echo "Error: Docker is not installed. Please install Docker first."
    exit 1
fi

if ! docker info &>/dev/null 2>&1; then
    echo "Error: Docker daemon is not running. Please start Docker."
    exit 1
fi

if ! command -v pnpm &>/dev/null; then
    echo "Error: pnpm is not installed. Please install pnpm first."
    exit 1
fi

# --- Start Docker containers ---
echo "Building and starting test containers..."
docker compose -f "$DOCKER_DIR/docker-compose.yml" up -d --build

# --- Wait for SSH to be ready ---
echo "Waiting for SSH server on port 2222..."
MAX_WAIT=30
WAITED=0
while ! nc -z 127.0.0.1 2222 2>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo "Error: SSH server did not start within ${MAX_WAIT}s."
        exit 1
    fi
done
echo "SSH server is ready."

# --- Print connection info ---
echo ""
echo "==========================================="
echo "  Test Environment Running"
echo "==========================================="
echo ""
echo "  SSH:    127.0.0.1:2222"
echo "  Telnet: 127.0.0.1:2323"
echo ""
echo "  Username: testuser"
echo "  Password: testpass"
echo ""
echo "==========================================="
echo ""

# --- Launch TermiHub with test config ---
echo "Launching TermiHub with test configuration..."
cd "$PROJECT_DIR"
TERMIHUB_CONFIG_DIR="$CONFIG_DIR" pnpm tauri dev
