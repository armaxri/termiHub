#!/usr/bin/env bash
#
# Stop the Docker test environment.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(cd "$SCRIPT_DIR/../docker" && pwd)"

echo "Stopping test containers..."
docker compose -f "$DOCKER_DIR/docker-compose.yml" down

echo "Test environment stopped."
