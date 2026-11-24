#!/bin/sh
# The agent setup script for POSIX hosts (agent_setup_posix.rs fills it in).
#
# It never loses a working agent (#5999): the new binary is copied into the
# install directory under its own name and must start there before the
# installed one is touched; the installed one is kept as <path>.previous; the
# swap is one rename, so there is always an agent at the install path; and
# anything that goes wrong afterwards puts the previous agent back.
#
# The "#@" lines mark every point between two changes. They are removed from
# the uploaded script; the tests fail and kill it at each one.
set -e

BINARY_SRC="__BINARY_SRC__"
INSTALL_PATH="__INSTALL_PATH__"
INSTALL_SERVICE=__INSTALL_SERVICE__
UNIT_DIR=/etc/systemd/system

# Exit codes the setup tab reads (agentSetupTabNotice).
EXIT_PREVIOUS_KEPT=__EXIT_PREVIOUS_KEPT__
EXIT_SERVICE_FAILED=__EXIT_SERVICE_FAILED__

SUDO=""
SERVICE_SUDO=""
REASON=""
TARGET=""
NEW=""
PREVIOUS=""
NEW_SUM=""
HAD_AGENT=false
OWN_PREVIOUS=false
SWAPPED=false
VERIFIED=false
DONE=false
SERVICE_CHANGING=false
SERVICE_WAS_ACTIVE=false
SERVICE_WAS_ENABLED=false
UNIT=""
UNIT_OLD=""

# --- Helpers ---
# Plain ASCII markers printed with printf only: `echo` does not expand escapes
# in every sh, so the output reads the same on any shell and locale (#5822).
say() {
    printf '%s\n' "$*"
}

fail() {
    REASON=$1
    say "[error] $1"
    if [ -n "$2" ]; then
        say "        $2"
    fi
    exit 1
}

# Whether a file runs as a termiHub agent.
starts() {
    [ -f "$1" ] && [ -x "$1" ] || return 1
    STARTS_OUT=$("$1" --version 2>/dev/null </dev/null) || return 1
    case "$STARTS_OUT" in
        "termihub-agent "*) return 0 ;;
    esac
    return 1
}

# Like `starts`, but a busy host gets a second and a third chance.
starts_surely() {
    starts "$1" && return 0
    [ -f "$1" ] || return 1
    sleep 1
    starts "$1" && return 0
    sleep 1
    starts "$1"
}

# A checksum of a file's contents (its size where cksum is missing).
sum() {
    if command -v cksum >/dev/null 2>&1; then
        $SUDO cat "$1" | cksum
    else
        $SUDO cat "$1" | wc -c
    fi
}

# The inode number of a file, empty when there is none.
inode() {
    ls -di "$1" 2>/dev/null | {
        read -r NUMBER _ || true
        printf '%s' "$NUMBER"
    }
}

# Rename $1 to $2 in the same directory. The kept agent may be a second name (a
# hard link) of the file it is to replace, when a setup was cut off before the
# swap. GNU mv refuses to rename that and BSD mv does not, so drop the name.
rename() {
    RENAME_FROM=$(inode "$1")
    if [ -n "$RENAME_FROM" ] && [ "$RENAME_FROM" = "$(inode "$2")" ]; then
        $SUDO rm -f "$1"
    else
        $SUDO mv -f "$1" "$2"
    fi
}

# Put the installed agent back after a failure. Only this run's own binary is
# replaced; whatever else is at the path by now is left alone while it starts.
roll_back() {
    [ "$SWAPPED" = true ] || return 0
    OURS=false
    if [ -f "$TARGET" ] && [ "$(sum "$TARGET")" = "$NEW_SUM" ]; then
        OURS=true
    fi
    if [ "$OURS" = false ] && starts_surely "$TARGET"; then
        return 0
    fi
    if [ "$OWN_PREVIOUS" = true ] && [ -f "$PREVIOUS" ]; then
        rename "$PREVIOUS" "$TARGET"
    elif [ "$OURS" = true ]; then
        # Nothing was installed before.
        $SUDO rm -f "$TARGET"
    fi
}

# Undo a half-made service change; the service itself is restarted afterwards.
undo_service() {
    [ "$SERVICE_CHANGING" = true ] || return 0
    if [ "$SERVICE_WAS_ACTIVE" = false ]; then
        $SERVICE_SUDO systemctl stop termihub-agent 2>/dev/null
    fi
    if [ "$SERVICE_WAS_ENABLED" = false ]; then
        $SERVICE_SUDO systemctl disable --quiet termihub-agent 2>/dev/null
    fi
    if [ -f "$UNIT_OLD" ]; then
        $SERVICE_SUDO mv -f "$UNIT_OLD" "$UNIT"
    else
        $SERVICE_SUDO rm -f "$UNIT"
    fi
    $SERVICE_SUDO rm -f "$UNIT.new.$$"
    $SERVICE_SUDO systemctl daemon-reload 2>/dev/null
}

# Runs on every exit. It removes the script itself, a leftover upload and its
# private upload dir, so the command typed into the terminal stays one short
# `sh` line (#5822). The last line printed is always the one summary line.
finish() {
    status=$?
    set +e
    trap - EXIT
    trap '' HUP INT TERM
    if [ "$DONE" = true ]; then
        status=0
    elif [ "$status" -eq 0 ]; then
        status=1
    fi
    code=$status
    if [ "$status" -ne 0 ]; then
        undo_service
        if [ "$VERIFIED" = true ] && [ "$SERVICE_WAS_ACTIVE" = false ]; then
            status=$EXIT_SERVICE_FAILED
        else
            roll_back
            if [ "$SERVICE_CHANGING" = true ]; then
                $SERVICE_SUDO systemctl restart termihub-agent
            fi
            if [ "$HAD_AGENT" = true ] && starts_surely "$TARGET"; then
                status=$EXIT_PREVIOUS_KEPT
            else
                status=1
            fi
        fi
    fi
    if [ -n "$NEW" ]; then
        for LEFT in "$NEW" "$PREVIOUS.$$"; do
            # Only then: sudo may ask for a password.
            [ ! -e "$LEFT" ] || $SUDO rm -f "$LEFT"
        done
        # A copy of the agent is dropped only while the installed one starts.
        if [ -f "$PREVIOUS" ] && starts_surely "$TARGET"; then
            if [ "$OWN_PREVIOUS" = true ] || starts "$PREVIOUS"; then
                $SUDO rm -f "$PREVIOUS"
            fi
        fi
    fi
    if [ -n "$UNIT_OLD" ] && [ -e "$UNIT_OLD" ]; then
        $SERVICE_SUDO rm -f "$UNIT_OLD"
    fi
    rm -f "$BINARY_SRC" "$0" 2>/dev/null
    rmdir "${0%/*}" 2>/dev/null
    case "$status" in
        0) ;;
        "$EXIT_PREVIOUS_KEPT") say "[ok] The previous agent is still in place and starts." ;;
        "$EXIT_SERVICE_FAILED") say "[ok] The new agent itself is installed and starts." ;;
    esac
    if [ "$status" -ne 0 ]; then
        say ""
        say "Agent setup failed: ${REASON:-a setup step exited with status $code (see above).}"
    fi
    exit "$status"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

say ""
say "=== termiHub Agent Setup ==="
say ""

# --- Step 1: Verify uploaded binary ---
say "[..] Checking the uploaded agent binary"
if [ -f "$BINARY_SRC" ]; then
    say "[ok] Agent binary uploaded"
else
    fail "The agent binary was not uploaded." "Run the setup again."
fi

# Uploads of setups that were killed, at least two days old.
case "${0%/*}" in
    */termihub-agent/updates/upload.*)
        find "${0%/*}/.." -type d -name 'upload.??????' -mtime +1 -prune -exec rm -rf {} + 2>/dev/null || true
        ;;
esac

# --- Step 2: Resolve install path ---
# shellcheck disable=SC2088 # matches a literal ~/ the desktop passed on
case "$INSTALL_PATH" in
    "~/"*) INSTALL_PATH="$HOME/${INSTALL_PATH#\~/}" ;;
    /*) ;;
    *) INSTALL_PATH="$PWD/$INSTALL_PATH" ;;
esac
say "[..] Install path: $INSTALL_PATH"

# A symbolic link stays one: the file it points to is replaced.
TARGET=$INSTALL_PATH
HOPS=0
while [ -L "$TARGET" ]; do
    HOPS=$((HOPS + 1))
    LINK=$(readlink "$TARGET") || LINK=""
    if [ -z "$LINK" ] || [ "$HOPS" -gt 40 ]; then
        fail "$INSTALL_PATH is a symbolic link that cannot be followed."
    fi
    case "$LINK" in
        /*) TARGET=$LINK ;;
        *) TARGET="$(dirname "$TARGET")/$LINK" ;;
    esac
done
TARGET_DIR=$(dirname "$TARGET")
NEW="$TARGET.new.$$"
PREVIOUS="$TARGET.previous"

# --- Step 3: Check permissions ---
say "[..] Checking write access to $TARGET_DIR"
if [ -d "$TARGET_DIR" ] && [ -w "$TARGET_DIR" ]; then
    say "[ok] $TARGET_DIR is writable"
else
    # Walk up to the first existing ancestor to check writability
    CHECK_DIR="$TARGET_DIR"
    while [ -n "$CHECK_DIR" ] && [ "$CHECK_DIR" != "/" ] && [ ! -d "$CHECK_DIR" ]; do
        CHECK_DIR=$(dirname "$CHECK_DIR")
    done
    if [ -w "$CHECK_DIR" ]; then
        say "[ok] $CHECK_DIR is writable"
    elif [ "$(id -u)" -eq 0 ]; then
        say "[ok] Running as root"
    elif command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
        say "[ok] Using sudo to write to $TARGET_DIR"
    else
        starts "$TARGET" && HAD_AGENT=true
        fail "Cannot create $TARGET_DIR (permission denied, no sudo available)." "Ask the server admin to create the directory, or choose a writable path."
    fi
fi

# --- Step 4: Never replace a file that is not a termiHub agent ---
if [ -e "$PREVIOUS" ] && [ ! -f "$PREVIOUS" ]; then
    fail "$PREVIOUS already exists and is not a file." "Remove it or choose another install path."
fi
# A setup or update that was cut off may have left the agent not starting, and
# the previous one next to it. Never over an agent that starts.
if [ -f "$PREVIOUS" ] && ! starts_surely "$TARGET" && starts "$PREVIOUS"; then
    if [ ! -e "$TARGET" ] || [ -f "$TARGET" ]; then
        say "[..] Restoring the previous agent left by an unfinished setup"
        #@
        rename "$PREVIOUS" "$TARGET"
        #@
    fi
fi
if [ -e "$TARGET" ]; then
    if starts_surely "$TARGET"; then
        HAD_AGENT=true
        say "[..] Replacing the installed agent ($STARTS_OUT)"
    elif [ -f "$TARGET" ] && [ "$INSTALL_PATH" = "$HOME/.local/bin/termihub-agent" ]; then
        # termiHub's own path: the remains of an interrupted install.
        say "[..] Replacing the installed agent, which does not start"
    else
        fail "$INSTALL_PATH already exists and is not a termiHub agent; it was not replaced." "Remove it or choose another install path."
    fi
fi

# --- Step 5: Create directory ---
if [ ! -d "$TARGET_DIR" ]; then
    say "[..] Creating $TARGET_DIR"
    #@
    $SUDO mkdir -p "$TARGET_DIR"
fi

# Copies of setups that were killed; a setup still running keeps its own.
for STALE in "$TARGET".new.* "$TARGET".previous.*; do
    PID=${STALE##*.}
    case "$PID" in
        "" | *[!0-9]*) continue ;;
    esac
    if [ -f "$STALE" ] && ! kill -0 "$PID" 2>/dev/null && ! ps -p "$PID" >/dev/null 2>&1; then
        $SUDO rm -f "$STALE"
    fi
done
#@

# --- Step 6: Copy the new agent next to the install path and start it there ---
# A fresh file each time, never an open one. It takes over the mode and owner
# of the installed agent.
say "[..] Copying the new agent to $TARGET_DIR"
$SUDO rm -f "$NEW"
#@
if [ -f "$TARGET" ] && $SUDO cp -p "$TARGET" "$NEW" 2>/dev/null; then
    #@
    $SUDO chmod u+rwx "$NEW"
    FRESH=false
else
    $SUDO rm -f "$NEW"
    FRESH=true
fi
#@
$SUDO tee "$NEW" <"$BINARY_SRC" >/dev/null ||
    fail "The new agent could not be written to $TARGET_DIR." "Check the free space there."
#@
if [ "$FRESH" = true ]; then
    $SUDO chmod +x "$NEW"
fi
#@
NEW_SUM=$(sum "$BINARY_SRC")
if [ "$(sum "$NEW")" != "$NEW_SUM" ]; then
    fail "The copy of the new agent in $TARGET_DIR is not complete." "Check the free space there."
fi
$SUDO sync "$NEW" 2>/dev/null || sync 2>/dev/null || true
#@
if ! VERSION_OUT=$("$NEW" --version 2>&1 </dev/null); then
    fail "The new agent does not start on this host: $(printf '%s\n' "$VERSION_OUT" | head -n 1)" "Check that the binary matches this host's architecture and that $TARGET_DIR allows running programs."
fi
if ! starts "$NEW"; then
    fail "The uploaded file is not a termiHub agent." "Choose the termihub-agent binary for this host."
fi
VERSION_LINE=$(printf '%s\n' "$VERSION_OUT" | head -n 1)

# --- Step 7: Keep the previous agent, then swap ---
say "[..] Installing the agent to $INSTALL_PATH"
#@
if [ -e "$TARGET" ]; then
    $SUDO rm -f "$PREVIOUS.$$"
    #@
    # A hard link needs no space and is the very same file; else a full copy.
    if ! $SUDO ln "$TARGET" "$PREVIOUS.$$" 2>/dev/null; then
        $SUDO cp -p "$TARGET" "$PREVIOUS.$$" ||
            fail "The installed agent could not be kept, so it was not replaced." "Check the free space in $TARGET_DIR."
        #@
        if [ "$(sum "$PREVIOUS.$$")" != "$(sum "$TARGET")" ]; then
            fail "The installed agent could not be kept, so it was not replaced." "Check the free space in $TARGET_DIR."
        fi
    fi
    #@
    rename "$PREVIOUS.$$" "$PREVIOUS"
    OWN_PREVIOUS=true
    #@
    $SUDO rm -f "$PREVIOUS.$$"
fi
SWAPPED=true
#@
$SUDO mv -f "$NEW" "$TARGET"
#@
$SUDO sync "$TARGET_DIR" 2>/dev/null || sync 2>/dev/null || true

# --- Step 8: Verify ---
say "[..] Verifying the installed agent"
if ! starts_surely "$INSTALL_PATH"; then
    fail "The installed agent at $INSTALL_PATH does not start."
fi
#@
if [ "$INSTALL_SERVICE" != true ]; then
    DONE=true
fi
VERIFIED=true
VERSION=${VERSION_LINE#termihub-agent }
VERSION=${VERSION#v}
# A branch build reports "0.1.0 (branch: develop)": show it as "v0.1.0 (develop)".
case "$VERSION" in
    *" (branch: "*")")
        BUILD_BRANCH=${VERSION#*branch: }
        VERSION_LABEL="v${VERSION%% *} (${BUILD_BRANCH%?})"
        ;;
    *) VERSION_LABEL="v$VERSION" ;;
esac
say "[ok] $VERSION_LINE"

# --- Step 9: Optional systemd service ---
# Restarted only now that the agent is proven. A service that ran before runs
# again after a failure, with the agent and the unit it had.
if [ "$INSTALL_SERVICE" = true ]; then
    say "[..] Installing the systemd service termihub-agent"
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
        SERVICE_SUDO="sudo"
    fi
    UNIT="$UNIT_DIR/termihub-agent.service"
    # Of setups that were killed here.
    for STALE in "$UNIT".new.* "$UNIT".previous.*; do
        [ ! -f "$STALE" ] || $SERVICE_SUDO rm -f "$STALE"
    done
    if systemctl is-active --quiet termihub-agent 2>/dev/null; then
        SERVICE_WAS_ACTIVE=true
    fi
    if systemctl is-enabled --quiet termihub-agent 2>/dev/null; then
        SERVICE_WAS_ENABLED=true
    fi
    if [ -f "$UNIT" ]; then
        UNIT_OLD="$UNIT.previous.$$"
        $SERVICE_SUDO cp -p "$UNIT" "$UNIT_OLD" || fail "The service could not be changed."
    fi
    #@
    SERVICE_CHANGING=true
    printf '[Unit]\nDescription=termiHub Agent\nAfter=network.target\n\n[Service]\nExecStart=%s --listen 127.0.0.1:7685\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n' "$INSTALL_PATH" |
        $SERVICE_SUDO tee "$UNIT.new.$$" >/dev/null || fail "The service could not be written."
    #@
    $SERVICE_SUDO mv -f "$UNIT.new.$$" "$UNIT" || fail "The service could not be written."
    #@
    $SERVICE_SUDO systemctl daemon-reload || fail "The service could not be registered."
    say "[ok] Service registered"
    #@
    $SERVICE_SUDO systemctl enable --quiet termihub-agent || fail "The service could not be enabled."
    say "[ok] Service enabled"
    #@
    $SERVICE_SUDO systemctl restart termihub-agent || fail "The service could not be started."
    sleep 1
    systemctl is-active --quiet termihub-agent || fail "The service did not keep running."
    say "[ok] Service started"
    #@
    DONE=true
fi

# The summary names the path home-relative; the full one is printed above.
SHOWN_PATH=$INSTALL_PATH
if [ -n "$HOME" ] && [ "$HOME" != / ]; then
    case "$INSTALL_PATH" in
        "$HOME"/*) SHOWN_PATH="~${INSTALL_PATH#"$HOME"}" ;;
    esac
fi
say ""
say "Agent $VERSION_LABEL installed at $SHOWN_PATH. You can close this tab."
