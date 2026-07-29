#!/usr/bin/env bash
# One-command runner for the Python **bridge** system-test harness
# (`tests/system/`). Replaces the manual three-step dance — build the app,
# bring up the Docker fixtures, then `cd tests/system && ./pytest.sh …` — with a
# single entry point.
#
# This runs the host-native bridge harness, so it works on macOS, Linux, and
# Windows (via the .cmd variant) — unlike the retired legacy tauri-driver flow.
#
# Run from anywhere in the repo:
#
#   ./scripts/test-system-py.sh --debug -k sftp_infra -x -s
#   ./scripts/test-system-py.sh --fixtures "ssh-password ssh-keys" -m integration -k ssh
#   ./scripts/test-system-py.sh --skip-build -m "not integration"
#
# What it does:
#   1. Builds the app if missing or stale (honoring --debug for a faster loop).
#   2. Brings up only the requested Docker fixtures (--fixtures; none by default).
#   3. Forwards all remaining arguments verbatim to tests/system/pytest.sh.
#
# Options (everything else is passed through to pytest):
#   --debug              Build/use the debug profile (target/debug; faster build)
#   --release            Build/use the release profile (target/release; default)
#   --skip-build         Never build; use the existing binary (error if missing)
#   --rebuild            Force a rebuild even if the binary looks up to date
#   --fixtures "<svc …>" Docker compose services to bring up (repeatable)
#   --dry-run            Print the resolved plan and exit (no build/fixtures/run)
#   --help, -h           Show this help message
#   --                   Pass every following argument straight to pytest
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Resolve this checkout's test environment (Compose project, offset ports,
# serial device paths, driver port) from dev.local.json, so several checkouts
# can run all test environments at once. See docs/testing.md.
source scripts/internal/dev-local-env.sh

# ─── Parse arguments ────────────────────────────────────────────────────────

PROFILE="release"
SKIP_BUILD=0
FORCE_REBUILD=0
DRY_RUN=0
FIXTURES=()
PYTEST_ARGS=()

while [ "$#" -gt 0 ]; do
    case "$1" in
        --debug)      PROFILE="debug" ;;
        --release)    PROFILE="release" ;;
        --skip-build) SKIP_BUILD=1 ;;
        --rebuild)    FORCE_REBUILD=1 ;;
        --dry-run)    DRY_RUN=1 ;;
        --fixtures)
            if [ "$#" -lt 2 ]; then
                echo "error: --fixtures requires a value, e.g. --fixtures \"ssh-password ssh-keys\"" >&2
                exit 1
            fi
            # Space-separated list; accumulates across repeated --fixtures flags.
            # The `${a[@]+…}` guard keeps an empty value safe under `set -u` on
            # bash 3.2 (macOS's default).
            read -r -a _svc <<< "$2"
            FIXTURES+=(${_svc[@]+"${_svc[@]}"})
            shift
            ;;
        --help|-h)
            # Print the contiguous comment header (skip the shebang, stop at the
            # first non-comment line) with the leading "# " stripped.
            awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
            exit 0
            ;;
        --)
            shift
            PYTEST_ARGS+=("$@")
            break
            ;;
        *)
            PYTEST_ARGS+=("$1")
            ;;
    esac
    shift
done

# ─── Resolve the app binary path for the chosen profile ─────────────────────
# Mirrors tests/system/termihub_harness/orchestrator.py (_app_binary_suffix +
# app_binary_candidates). Keep in sync if that resolution changes.

case "$(uname -s)" in
    Darwin)               BINARY_SUFFIX="bundle/macos/termiHub.app/Contents/MacOS/termiHub" ;;
    MINGW*|MSYS*|CYGWIN*) BINARY_SUFFIX="termihub.exe" ;;
    *)                    BINARY_SUFFIX="termihub" ;;
esac
APP_BINARY="target/$PROFILE/$BINARY_SUFFIX"

# ─── Decide whether to build ────────────────────────────────────────────────

needs_build() {
    [ "$FORCE_REBUILD" -eq 1 ] && return 0
    [ ! -f "$APP_BINARY" ] && return 0
    # Stale if any tracked frontend/backend source is newer than the binary.
    local newer
    newer="$(find src src-tauri/src core/src agent/src -type f -newer "$APP_BINARY" -print -quit 2>/dev/null || true)"
    [ -n "$newer" ]
}

# Decide the action without performing it yet, so --dry-run can report it.
if [ "$SKIP_BUILD" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$APP_BINARY" ]; then
        echo "ERROR: app binary not found at $APP_BINARY" >&2
        echo "Build it (drop --skip-build) or run: pnpm tauri build${PROFILE:+ --$PROFILE}" >&2
        exit 1
    fi
    BUILD_ACTION="skip (--skip-build)"
elif needs_build; then
    BUILD_ACTION="build"
else
    BUILD_ACTION="skip (up to date)"
fi

# ─── --dry-run: report the resolved plan and stop before any side effects ───

if [ "$DRY_RUN" -eq 1 ]; then
    echo "profile: $PROFILE"
    echo "binary: $APP_BINARY"
    echo "build: $BUILD_ACTION"
    echo "fixtures: ${FIXTURES[*]:-(none)}"
    echo "pytest: ${PYTEST_ARGS[*]:-(none)}"
    exit 0
fi

# ─── Build the app if needed ────────────────────────────────────────────────

if [ "$BUILD_ACTION" = "build" ]; then
    if [ ! -d node_modules ]; then
        echo "node_modules missing, running pnpm install..."
        pnpm install
    fi
    echo "=== Building termiHub ($PROFILE) ==="
    # The system-test bridge's in-app client connects out over a loopback
    # WebSocket (ws://127.0.0.1:<port>), but the production CSP in
    # tauri.conf.json no longer allows any ws:// in connect-src (#2059 — real
    # users never run the bridge, so the app needs no WebSocket connect-src). The
    # loopback allowance is re-added ONLY for test builds via this config overlay,
    # which deep-merges over tauri.conf.json. A build without it cannot connect
    # the bridge — so any test build MUST pass --config here (see also
    # system-integration.yml and tests/system/README.md).
    if [ "$PROFILE" = "debug" ]; then
        pnpm tauri build --debug --config src-tauri/tauri.test.conf.json
    else
        pnpm tauri build --config src-tauri/tauri.test.conf.json
    fi
else
    echo "=== Build $BUILD_ACTION, using $APP_BINARY ==="
fi

# Pin the harness to the profile we just built/selected, so a stale build of the
# other profile is never picked up instead.
export TERMIHUB_TEST_APP_BINARY="$PWD/$APP_BINARY"

# ─── Bring up the requested Docker fixtures ─────────────────────────────────

if [ "${#FIXTURES[@]}" -gt 0 ]; then
    # Detect the container runtime (override with CONTAINER_CMD=podman).
    if [ -z "${CONTAINER_CMD:-}" ]; then
        if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
            CONTAINER_CMD="docker"
        elif command -v podman &>/dev/null && podman info &>/dev/null 2>&1; then
            CONTAINER_CMD="podman"
        else
            echo "ERROR: no running container runtime found (docker/podman) for --fixtures." >&2
            echo "       Start Docker Desktop / Podman, or drop --fixtures." >&2
            exit 1
        fi
    fi

    COMPOSE_FILE="tests/docker/docker-compose.yml"
    echo "=== Bringing up fixtures: ${FIXTURES[*]} ==="
    # `up -d` is a no-op for already-running containers, so this stays fast on
    # repeat runs. Fixtures are left running afterwards (the harness keeps them
    # warm across runs); tear down with:
    #   $CONTAINER_CMD compose -f $COMPOSE_FILE down
    "$CONTAINER_CMD" compose -f "$COMPOSE_FILE" up -d --build "${FIXTURES[@]}"
fi

# ─── Run the harness ────────────────────────────────────────────────────────

echo "=== Running system tests (bridge harness) ==="
# `${a[@]+…}` so an empty arg list is safe under `set -u` on bash 3.2 (macOS).
exec tests/system/pytest.sh ${PYTEST_ARGS[@]+"${PYTEST_ARGS[@]}"}
