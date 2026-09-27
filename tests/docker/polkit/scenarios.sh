#!/usr/bin/env bash
# In-container driver for the headless polkit D-Bus test (#3553).
#
# Runs as root inside the tests/docker/polkit image (started by run.sh). Brings
# up a system bus and polkitd, then drives termiHub's real polkit transport
# (the `polkit-probe` binary, running as an unprivileged user so polkit sees a
# normal subject) through every outcome the verifier maps:
#
#   polkit not running          -> ServiceUnavailable
#   policy not installed        -> registered=false, check -> ActionNotRegistered
#   policy installed            -> registered=true
#   shipped defaults, no session-> denied (allow_any = no)
#   rules: YES / NO             -> authorized / denied
#   rules: AUTH_SELF, no agent  -> is_challenge (the "no agent" outcome)
#   pkttyagent, right password  -> authorized (real PAM check)
#   pkttyagent, wrong password  -> denied
#   agent returns Cancelled     -> polkit.dismissed
#   agent never answers         -> TimedOut + CancelCheckAuthorization reaches it
#
# Exits non-zero if any scenario fails.
set -euo pipefail

PROBE="${POLKIT_PROBE:?set POLKIT_PROBE to the polkit-probe binary}"
POLICY="${POLKIT_POLICY:?set POLKIT_POLICY to com.termihub.app.policy}"
ACTION="com.termihub.app.reauthenticate"
TEST_USER="tester"
TEST_PASSWORD="tester-password"
RULES="/etc/polkit-1/rules.d/10-termihub-probe.rules"
POLKITD_PID=""
FAILURES=0

log() { printf '%s\n' "$*"; }

check() {
    local name="$1" expected="$2" actual="$3"
    if [[ "$actual" == "$expected" ]]; then
        log "PASS  $name: $actual"
    else
        log "FAIL  $name: expected '$expected', got '$actual'"
        FAILURES=$((FAILURES + 1))
    fi
}

as_user() { runuser -u "$TEST_USER" -- "$@"; }

# The probe's single answer line (it prints `error=…` and exits 2 on a
# transport error, which is an answer too).
probe() { as_user env "$@" 2>&1 || true; }

start_polkitd() {
    /usr/lib/polkit-1/polkitd --no-debug >/tmp/polkitd.log 2>&1 &
    POLKITD_PID=$!
    local _
    for _ in $(seq 1 50); do
        if [[ "$(probe "$PROBE" registered "$ACTION")" == registered=* ]]; then
            return 0
        fi
        sleep 0.2
    done
    log "polkitd did not come up:"
    cat /tmp/polkitd.log
    exit 1
}

# Restart polkitd so a changed action / rules file is definitely loaded
# (instead of racing its inotify reload).
restart_polkitd() {
    kill "$POLKITD_PID"
    wait "$POLKITD_PID" 2>/dev/null || true
    start_polkitd
}

use_rule() {
    local result="$1"
    cat >"$RULES" <<EOF
polkit.addRule(function (action, subject) {
    if (action.id == "$ACTION" && subject.user == "$TEST_USER") {
        return polkit.Result.$result;
    }
});
EOF
    restart_polkitd
}

wait_for_line() {
    local file="$1" pattern="$2" _
    for _ in $(seq 1 100); do
        grep -q "$pattern" "$file" && return 0
        sleep 0.1
    done
    return 1
}

# Whether the bus log from `dbus-monitor` holds a CancelCheckAuthorization
# call that polkit answered with a method return (not an error). Proves the
# verifier's own cancel reached polkit and was accepted - the caller vanishing
# would also make polkit withdraw the prompt, so the agent side alone is not
# proof.
cancel_was_accepted() {
    awk '
        /^method call / && /member=CancelCheckAuthorization/ {
            for (i = 1; i <= NF; i++) {
                if ($i ~ /^sender=/) sender = substr($i, 8)
                if ($i ~ /^serial=/) serial = substr($i, 8)
            }
            calls[sender " " serial] = 1
            next
        }
        /^method return / {
            for (i = 1; i <= NF; i++) {
                if ($i ~ /^destination=/) dest = substr($i, 13)
                if ($i ~ /^reply_serial=/) reply = substr($i, 14)
            }
            if ((dest " " reply) in calls) accepted = 1
        }
        END { exit accepted ? 0 : 1 }
    ' "$1"
}

# Run `check` with the scripted zbus agent (`polkit-probe agent <mode>`)
# registered for the probe's process. Sets CHECK_RESULT and AGENT_LOG.
check_with_scripted_agent() {
    local mode="$1"
    shift
    local agent_log line pid agent_pid
    agent_log="$(mktemp)"
    chmod 666 "$agent_log"
    coproc PROBE_PROC {
        as_user env POLKIT_PROBE_WAIT_FOR_AGENT=1 "$@" "$PROBE" check "$ACTION" 2>&1
    }
    read -r -t 10 line <&"${PROBE_PROC[0]}" || line=""
    pid="${line#pid=}"
    as_user "$PROBE" agent "$mode" "$pid" >"$agent_log" 2>&1 &
    agent_pid=$!
    if ! wait_for_line "$agent_log" '^agent=registered'; then
        log "scripted agent did not register:"
        cat "$agent_log"
    fi
    echo go >&"${PROBE_PROC[1]}"
    read -r -t 30 CHECK_RESULT <&"${PROBE_PROC[0]}" || CHECK_RESULT="<probe never answered>"
    wait "$agent_pid" || true
    AGENT_LOG="$(cat "$agent_log")"
    rm -f "$agent_log"
}

# ---------------------------------------------------------------- setup
useradd --create-home "$TEST_USER"
echo "$TEST_USER:$TEST_PASSWORD" | chpasswd
mkdir -p /run/dbus
dbus-daemon --system --fork

log "== polkit D-Bus integration (#3553)"

# ---------------------------------------------------------------- scenarios
# 1. No polkitd on the bus (bus activation is disabled in the image).
result="$(probe "$PROBE" registered "$ACTION")"
check "polkit not running -> ServiceUnavailable" "error=ServiceUnavailable" "${result%%(*}"

start_polkitd

# 2. Policy not installed (AppImage / portable build).
check "policy not installed -> not registered" "registered=false" \
    "$(probe "$PROBE" registered "$ACTION")"
check "check on unregistered action -> ActionNotRegistered" "error=ActionNotRegistered" \
    "$(probe "$PROBE" check "$ACTION")"

# 3. The shipped policy file installed (.deb / .rpm).
install -m 644 "$POLICY" /usr/share/polkit-1/actions/
restart_polkitd
check "policy installed -> registered" "registered=true" \
    "$(probe "$PROBE" registered "$ACTION")"

# 4. Shipped defaults: the subject has no active session, so allow_any = no.
check "shipped defaults outside an active session -> denied" \
    "authorized=false challenge=false dismissed=false" "$(probe "$PROBE" check "$ACTION")"

# 5. Rules decide without prompting.
use_rule YES
check "rule YES -> authorized" "authorized=true challenge=false dismissed=false" \
    "$(probe "$PROBE" check "$ACTION")"
use_rule NO
check "rule NO -> denied" "authorized=false challenge=false dismissed=false" \
    "$(probe "$PROBE" check "$ACTION")"

# 6. auth_self (what the shipped policy asks of an active session).
use_rule AUTH_SELF
check "auth_self with no agent -> challenge (no agent)" \
    "authorized=false challenge=true dismissed=false" "$(probe "$PROBE" check "$ACTION")"

result="$(as_user expect /fixture/pkttyagent.exp "$PROBE" "$ACTION" "$TEST_PASSWORD" |
    sed -n 's/^RESULT //p' | tr -d '\r')"
check "pkttyagent + right password -> authorized" \
    "authorized=true challenge=false dismissed=false" "$result"

result="$(as_user expect /fixture/pkttyagent.exp "$PROBE" "$ACTION" "not-the-password" |
    sed -n 's/^RESULT //p' | tr -d '\r')"
check "pkttyagent + wrong password -> denied" \
    "authorized=false challenge=false dismissed=false" "$result"

check_with_scripted_agent dismiss
check "agent dismisses the dialog -> dismissed" \
    "authorized=false challenge=false dismissed=true" "$CHECK_RESULT"
check "dismiss: polkit asked the agent" "begin=$ACTION" "$(grep '^begin=' <<<"$AGENT_LOG" || true)"

bus_log="$(mktemp)"
dbus-monitor --system "type='method_call',member='CancelCheckAuthorization'" \
    "type='method_return'" >"$bus_log" 2>&1 &
monitor_pid=$!
# dbus-monitor drops its own name (NameLost) once it has become a monitor.
wait_for_line "$bus_log" 'member=NameLost' || log "dbus-monitor did not start"
check_with_scripted_agent hang POLKIT_PROBE_TIMEOUT_SECS=3
sleep 0.5
kill "$monitor_pid"
wait "$monitor_pid" 2>/dev/null || true
check "prompt outlives the timeout -> TimedOut" "error=TimedOut" "$CHECK_RESULT"
if cancel_was_accepted "$bus_log"; then cancelled=accepted; else cancelled=missing; fi
check "timeout: polkit accepted the verifier's CancelCheckAuthorization" accepted "$cancelled"
check "timeout: polkit withdrew the prompt from the agent" "cancel" \
    "$(grep -o '^cancel' <<<"$AGENT_LOG" || true)"
if [[ "$cancelled" != accepted ]]; then
    log "-- bus log:"
    cat "$bus_log"
fi
rm -f "$bus_log"

# ---------------------------------------------------------------- verdict
if ((FAILURES > 0)); then
    log "== $FAILURES scenario(s) FAILED"
    log "-- polkitd log:"
    cat /tmp/polkitd.log
    exit 1
fi
log "== all polkit scenarios passed"
