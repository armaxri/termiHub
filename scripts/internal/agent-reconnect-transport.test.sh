#!/usr/bin/env bash
# Unit test for the pure classifiers in agent-reconnect-transport.sh
# (comm_of + is_sshd_family) — the drop kill-list decision.
#
# Guards #2550: on macOS 26 / OpenSSH 10 the sshd master listener's `ps -o comm=`
# is the rewritten process TITLE `sshd:` (trailing colon), which used to match
# neither `sshd` nor `sshd-*`, so `drop` spared the listener and no prolonged
# outage was ever created. `ps` is faked here so the classification runs in
# isolation — no live agent, no sshd, headless, deterministic.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Fake `ps`: map a synthetic pid (via the `-p <pid>` form comm_of uses) to the
# comm string a real `ps -o comm=` would print on the target platform. Overriding
# the `ps` builtin/command with a function is honoured by comm_of's `ps ...` call.
ps() {
    local pid=""
    while [ $# -gt 0 ]; do
        case "$1" in
        -p)
            pid="$2"
            shift 2
            ;;
        *) shift ;;
        esac
    done
    case "$pid" in
    # macOS 26 / OpenSSH 10 process-title forms (the #2550 shapes).
    1001) printf 'sshd: /usr/sbin/sshd -f /tmp/x/sshd_config [listener] 0 of 10-100 startups\n' ;;
    1002) printf 'sshd-session: arne [priv]\n' ;;
    1003) printf 'sshd-session: arne@notty\n' ;;
    # Linux / older-OpenSSH bare-name and exec-path forms.
    1004) printf 'sshd\n' ;;
    1005) printf 'sshd-session\n' ;;
    1006) printf '/usr/sbin/sshd\n' ;;
    # Non-sshd processes that MUST be spared by the kill list.
    1007) printf '/Users/arne/work/git/termiHub/target/debug/termihub\n' ;;
    1008) printf '/Users/arne/work/git/termiHub/target/debug/termihub-agent\n' ;;
    *) return 1 ;;
    esac
}

# Source the script under test. Its `BASH_SOURCE[0] == $0` guard is false here, so
# only the function definitions load — no cd, no port resolution, no action.
# shellcheck source=scripts/internal/agent-reconnect-transport.sh
source "$SCRIPT_DIR/agent-reconnect-transport.sh"
# The sourced script runs `set -euo pipefail`; drop `-e` so a deliberate non-zero
# from is_sshd_family (its "no match" return) does not abort the test.
set +e

fail=0

check_comm() { # <pid> <expected-normalised-comm>
    local got
    got="$(comm_of "$1")"
    if [ "$got" != "$2" ]; then
        printf 'FAIL comm_of(%s): got [%s] want [%s]\n' "$1" "$got" "$2" >&2
        fail=1
    fi
}

check_family() { # <pid> <yes|no>
    local got
    if is_sshd_family "$(comm_of "$1")"; then got=yes; else got=no; fi
    if [ "$got" != "$2" ]; then
        printf 'FAIL is_sshd_family(comm_of(%s)): got %s want %s\n' "$1" "$got" "$2" >&2
        fail=1
    fi
}

# comm_of normalisation (process-title colon strip + exec-path basename).
check_comm 1001 sshd         # macOS listener TITLE `sshd:` -> `sshd`  (#2550)
check_comm 1002 sshd-session # macOS handler `sshd-session: arne [priv]`
check_comm 1003 sshd-session # macOS handler `sshd-session: arne@notty`
check_comm 1004 sshd         # Linux / older bare name
check_comm 1005 sshd-session # Linux / newer split handler
check_comm 1006 sshd         # exec path -> basename
check_comm 1007 termihub
check_comm 1008 termihub-agent

# is_sshd_family classification — the actual drop kill-list decision.
check_family 1001 yes # #2550: the master LISTENER must be reaped
check_family 1002 yes # per-connection handler
check_family 1003 yes # per-connection handler
check_family 1004 yes
check_family 1005 yes
check_family 1006 yes
check_family 1007 no # the app (termihub) must be spared
check_family 1008 no # the agent (termihub-agent) must be spared

if [ "$fail" -ne 0 ]; then
    echo "agent-reconnect-transport classifier tests: FAILED" >&2
    exit 1
fi
echo "agent-reconnect-transport classifier tests: OK (12 comm + 8 family assertions)"
