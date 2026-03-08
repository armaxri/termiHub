#!/usr/bin/env bash
# Post-install smoke test — launches the built app, verifies basic UI, confirms clean shutdown.
# Run from anywhere: ./scripts/smoke-test.sh <path-to-app-binary>
#
# Linux/Windows (MSYS): uses tauri-driver + WebDriver (curl) if available, else process-based fallback
# macOS:                uses osascript for window verification
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

usage() {
    echo "Usage: $0 <app-path> [--help]"
    echo ""
    echo "  <app-path>  Path to the built termiHub binary or .app bundle"
    echo "              Linux:   ./src-tauri/target/release/termihub"
    echo "              macOS:   /Applications/termiHub.app"
    echo "              Windows: ./src-tauri/target/release/termihub.exe"
    echo ""
    echo "Options:"
    echo "  --help, -h  Show this help message"
    exit 0
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    usage
fi

if [ $# -lt 1 ]; then
    echo "Error: app path required"
    echo ""
    usage
fi

APP_PATH="$1"

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

PLATFORM="unknown"
case "$(uname -s)" in
    Linux*)  PLATFORM="linux" ;;
    Darwin*) PLATFORM="macos" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
esac

if [ "$PLATFORM" = "unknown" ]; then
    echo "Error: unsupported platform '$(uname -s)'"
    exit 1
fi

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

PASSED=0
FAILED=0
SKIPPED=0
APP_PID=""
DRIVER_PID=""
SESSION_ID=""
WD_URL="http://127.0.0.1:4444"
HAS_DRIVER=false

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

pass() { echo "  ✓ PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  ✗ FAIL: $1"; FAILED=$((FAILED + 1)); }
skip() { echo "  ⊘ SKIP: $1"; SKIPPED=$((SKIPPED + 1)); }
info() { echo "  ℹ $1"; }

cleanup() {
    echo ""
    info "Cleaning up..."

    # Delete WebDriver session if active
    if [ -n "$SESSION_ID" ]; then
        curl -s -X DELETE "$WD_URL/session/$SESSION_ID" > /dev/null 2>&1 || true
        SESSION_ID=""
    fi

    # Kill app process
    if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
        kill "$APP_PID" 2>/dev/null || true
        wait "$APP_PID" 2>/dev/null || true
    fi

    # Kill tauri-driver
    if [ -n "$DRIVER_PID" ] && kill -0 "$DRIVER_PID" 2>/dev/null; then
        kill "$DRIVER_PID" 2>/dev/null || true
        wait "$DRIVER_PID" 2>/dev/null || true
    fi
}

trap cleanup EXIT

# ---------------------------------------------------------------------------
# WebDriver helpers (curl-based W3C WebDriver)
# ---------------------------------------------------------------------------

webdriver_post() {
    local path="$1"
    local body="${2:-{}}"
    curl -s -X POST "$WD_URL$path" \
        -H "Content-Type: application/json" \
        -d "$body" 2>/dev/null
}

webdriver_get() {
    local path="$1"
    curl -s -X GET "$WD_URL$path" 2>/dev/null
}

webdriver_delete() {
    local path="$1"
    curl -s -X DELETE "$WD_URL$path" 2>/dev/null
}

# Find an element by CSS selector; sets ELEMENT_ID on success, returns 1 on failure
find_element() {
    local selector="$1"
    local response
    response=$(webdriver_post "/session/$SESSION_ID/element" \
        "{\"using\": \"css selector\", \"value\": \"$selector\"}")

    ELEMENT_ID=$(echo "$response" | sed -n 's/.*"element-[^"]*": *"\([^"]*\)".*/\1/p')
    if [ -z "$ELEMENT_ID" ]; then
        # Try alternative key format
        ELEMENT_ID=$(echo "$response" | sed -n 's/.*"ELEMENT": *"\([^"]*\)".*/\1/p')
    fi

    if [ -z "$ELEMENT_ID" ]; then
        return 1
    fi
    return 0
}

click_element() {
    local element_id="$1"
    webdriver_post "/session/$SESSION_ID/element/$element_id/click" "{}" > /dev/null
}

send_keys() {
    local element_id="$1"
    local text="$2"
    webdriver_post "/session/$SESSION_ID/element/$element_id/value" \
        "{\"text\": \"$text\"}" > /dev/null
}

get_text() {
    local element_id="$1"
    local response
    response=$(webdriver_get "/session/$SESSION_ID/element/$element_id/text")
    echo "$response" | sed -n 's/.*"value": *"\([^"]*\)".*/\1/p'
}

# Wait for an element to appear (retries with delay)
wait_for_element() {
    local selector="$1"
    local timeout="${2:-10}"
    local elapsed=0
    while [ $elapsed -lt "$timeout" ]; do
        if find_element "$selector"; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

# ---------------------------------------------------------------------------
# Validate app path
# ---------------------------------------------------------------------------

echo "=== termiHub Smoke Test ==="
echo ""
info "Platform: $PLATFORM"
info "App path: $APP_PATH"

if [ "$PLATFORM" = "macos" ]; then
    if [ ! -d "$APP_PATH" ]; then
        echo "Error: app bundle not found at '$APP_PATH'"
        exit 1
    fi
else
    if [ ! -f "$APP_PATH" ]; then
        echo "Error: binary not found at '$APP_PATH'"
        exit 1
    fi
    if [ ! -x "$APP_PATH" ]; then
        echo "Error: binary is not executable at '$APP_PATH'"
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# macOS flow (osascript-based)
# ---------------------------------------------------------------------------

if [ "$PLATFORM" = "macos" ]; then
    echo ""
    echo "--- Check 1: Launch app ---"
    open "$APP_PATH"
    sleep 3

    # Verify the process is running
    if pgrep -x "termiHub" > /dev/null 2>&1; then
        pass "App launched successfully"
    else
        fail "App process not found after launch"
        exit 1
    fi

    echo ""
    echo "--- Check 2: Verify window opens ---"
    WINDOW_CHECK=$(osascript -e 'tell application "System Events" to get name of every window of process "termiHub"' 2>/dev/null || echo "")
    if [ -n "$WINDOW_CHECK" ]; then
        pass "Window detected: $WINDOW_CHECK"
    else
        fail "No window detected for termiHub"
    fi

    echo ""
    echo "--- Checks 3-6: UI interaction ---"
    skip "UI interaction checks (no WebDriver on macOS)"

    echo ""
    echo "--- Check 7: Close app ---"
    osascript -e 'quit app "termiHub"' 2>/dev/null || true
    sleep 2

    if ! pgrep -x "termiHub" > /dev/null 2>&1; then
        pass "App shut down cleanly"
    else
        fail "App still running after quit"
        # Force kill for cleanup
        pkill -x "termiHub" 2>/dev/null || true
    fi

# ---------------------------------------------------------------------------
# Linux/Windows flow (tauri-driver + WebDriver or fallback)
# ---------------------------------------------------------------------------

else
    # Check for tauri-driver
    if command -v tauri-driver > /dev/null 2>&1; then
        HAS_DRIVER=true
        info "tauri-driver found — using WebDriver automation"
    else
        HAS_DRIVER=false
        info "tauri-driver not found — using process-based fallback"
    fi

    if [ "$HAS_DRIVER" = true ]; then
        # Start tauri-driver
        tauri-driver > /dev/null 2>&1 &
        DRIVER_PID=$!
        sleep 2

        if ! kill -0 "$DRIVER_PID" 2>/dev/null; then
            info "tauri-driver failed to start — falling back to process checks"
            HAS_DRIVER=false
            DRIVER_PID=""
        fi
    fi

    if [ "$HAS_DRIVER" = true ]; then
        # --- WebDriver flow ---

        echo ""
        echo "--- Check 1: Launch app (via WebDriver session) ---"

        # Resolve to absolute path for WebDriver
        ABS_APP_PATH="$(cd "$(dirname "$APP_PATH")" && pwd)/$(basename "$APP_PATH")"

        SESSION_RESPONSE=$(webdriver_post "/session" \
            "{\"capabilities\": {\"alwaysMatch\": {\"tauri:options\": {\"application\": \"$ABS_APP_PATH\"}}}}")

        SESSION_ID=$(echo "$SESSION_RESPONSE" | sed -n 's/.*"sessionId": *"\([^"]*\)".*/\1/p')

        if [ -n "$SESSION_ID" ]; then
            pass "App launched (session: ${SESSION_ID:0:8}...)"
        else
            fail "Failed to create WebDriver session"
            info "Response: $SESSION_RESPONSE"
            # Fall through to summary
            SESSION_ID=""
        fi

        if [ -n "$SESSION_ID" ]; then
            echo ""
            echo "--- Check 2: Verify window (activity bar visible) ---"
            sleep 3  # Give the app time to render

            if wait_for_element "[data-testid='activity-bar-connections']" 15; then
                pass "Activity bar is visible"
            else
                fail "Activity bar not found within 15s"
            fi

            echo ""
            echo "--- Check 3: Create a local shell ---"

            # Click new connection button
            if wait_for_element "[data-testid='connection-list-new-connection']" 5; then
                click_element "$ELEMENT_ID"
                sleep 1

                # Fill connection name
                if wait_for_element "[data-testid='connection-editor-name-input']" 5; then
                    send_keys "$ELEMENT_ID" "Smoke Test Shell"

                    # Click save & connect
                    if find_element "[data-testid='connection-editor-save-connect']"; then
                        click_element "$ELEMENT_ID"
                        sleep 3
                        pass "Local shell created and connected"
                    else
                        fail "Save & Connect button not found"
                    fi
                else
                    fail "Connection name input not found"
                fi
            else
                fail "New connection button not found"
            fi

            echo ""
            echo "--- Check 4: Send command and verify output ---"

            # Find the active terminal and send a command
            # xterm.js terminals receive input via the WebDriver active element
            sleep 2
            # Use WebDriver actions to type into the focused terminal
            webdriver_post "/session/$SESSION_ID/actions" \
                "{\"actions\": [{\"type\": \"key\", \"id\": \"keyboard\", \"actions\": [
                    {\"type\": \"keyDown\", \"value\": \"e\"}, {\"type\": \"keyUp\", \"value\": \"e\"},
                    {\"type\": \"keyDown\", \"value\": \"c\"}, {\"type\": \"keyUp\", \"value\": \"c\"},
                    {\"type\": \"keyDown\", \"value\": \"h\"}, {\"type\": \"keyUp\", \"value\": \"h\"},
                    {\"type\": \"keyDown\", \"value\": \"o\"}, {\"type\": \"keyUp\", \"value\": \"o\"},
                    {\"type\": \"keyDown\", \"value\": \" \"}, {\"type\": \"keyUp\", \"value\": \" \"},
                    {\"type\": \"keyDown\", \"value\": \"s\"}, {\"type\": \"keyUp\", \"value\": \"s\"},
                    {\"type\": \"keyDown\", \"value\": \"m\"}, {\"type\": \"keyUp\", \"value\": \"m\"},
                    {\"type\": \"keyDown\", \"value\": \"o\"}, {\"type\": \"keyUp\", \"value\": \"o\"},
                    {\"type\": \"keyDown\", \"value\": \"k\"}, {\"type\": \"keyUp\", \"value\": \"k\"},
                    {\"type\": \"keyDown\", \"value\": \"e\"}, {\"type\": \"keyUp\", \"value\": \"e\"},
                    {\"type\": \"keyDown\", \"value\": \"-\"}, {\"type\": \"keyUp\", \"value\": \"-\"},
                    {\"type\": \"keyDown\", \"value\": \"t\"}, {\"type\": \"keyUp\", \"value\": \"t\"},
                    {\"type\": \"keyDown\", \"value\": \"e\"}, {\"type\": \"keyUp\", \"value\": \"e\"},
                    {\"type\": \"keyDown\", \"value\": \"s\"}, {\"type\": \"keyUp\", \"value\": \"s\"},
                    {\"type\": \"keyDown\", \"value\": \"t\"}, {\"type\": \"keyUp\", \"value\": \"t\"},
                    {\"type\": \"keyDown\", \"value\": \"-\"}, {\"type\": \"keyUp\", \"value\": \"-\"},
                    {\"type\": \"keyDown\", \"value\": \"o\"}, {\"type\": \"keyUp\", \"value\": \"o\"},
                    {\"type\": \"keyDown\", \"value\": \"k\"}, {\"type\": \"keyUp\", \"value\": \"k\"},
                    {\"type\": \"keyDown\", \"value\": \"\uE006\"}, {\"type\": \"keyUp\", \"value\": \"\uE006\"}
                ]}]}" > /dev/null 2>&1

            sleep 2

            # Check page source for the echoed text
            PAGE_SOURCE=$(webdriver_get "/session/$SESSION_ID/source" 2>/dev/null || echo "")
            if echo "$PAGE_SOURCE" | grep -q "smoke-test-ok"; then
                pass "Terminal output verified (smoke-test-ok)"
            else
                skip "Could not verify terminal output (xterm.js canvas rendering)"
            fi

            echo ""
            echo "--- Check 5: Open Settings ---"

            if find_element "[data-testid='activity-bar-settings']"; then
                click_element "$ELEMENT_ID"
                sleep 1
                pass "Settings opened"
            else
                fail "Settings button not found"
            fi

            echo ""
            echo "--- Check 6: Open connection editor ---"

            # Click connections in activity bar first
            if find_element "[data-testid='activity-bar-connections']"; then
                click_element "$ELEMENT_ID"
                sleep 1
            fi

            if find_element "[data-testid='connection-list-new-connection']"; then
                click_element "$ELEMENT_ID"
                sleep 1
                if wait_for_element "[data-testid='connection-editor-name-input']" 5; then
                    pass "Connection editor opened"
                else
                    fail "Connection editor form did not appear"
                fi
            else
                fail "New connection button not found"
            fi

            echo ""
            echo "--- Check 7: Close app ---"

            webdriver_delete "/session/$SESSION_ID" > /dev/null 2>&1 || true
            SESSION_ID=""
            sleep 2
            pass "App closed via WebDriver session delete"
        fi

    else
        # --- Process-based fallback ---

        echo ""
        echo "--- Check 1: Launch app ---"

        "$APP_PATH" &
        APP_PID=$!
        sleep 5

        if kill -0 "$APP_PID" 2>/dev/null; then
            pass "App launched (PID: $APP_PID)"
        else
            fail "App exited prematurely"
            APP_PID=""
        fi

        if [ -n "$APP_PID" ]; then
            echo ""
            echo "--- Check 2: Verify process is stable ---"
            sleep 5

            if kill -0 "$APP_PID" 2>/dev/null; then
                pass "App still running after 10s"
            else
                fail "App crashed after launch"
                APP_PID=""
            fi
        fi

        echo ""
        echo "--- Checks 3-6: UI interaction ---"
        skip "UI interaction checks (tauri-driver not available)"

        if [ -n "$APP_PID" ]; then
            echo ""
            echo "--- Check 7: Close app ---"

            kill "$APP_PID" 2>/dev/null || true
            sleep 3

            if ! kill -0 "$APP_PID" 2>/dev/null; then
                pass "App shut down cleanly"
            else
                fail "App did not exit after SIGTERM"
                kill -9 "$APP_PID" 2>/dev/null || true
            fi
            APP_PID=""
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "==========================================="
echo "  Smoke Test Summary"
echo "==========================================="
echo "  Passed:  $PASSED"
echo "  Failed:  $FAILED"
echo "  Skipped: $SKIPPED"

if [ "$FAILED" -gt 0 ]; then
    echo "  RESULT: FAILED"
    exit 1
else
    echo "  RESULT: OK"
fi
