#!/usr/bin/env bash
#
# Verify the plugin runner shipped next to a built or installed termiHub (#4202).
#
# Usage:
#   scripts/internal/verify-plugin-runner-bundle.sh [--no-run] [--runner <path>]
#                                                   <app-binary>
#
# <app-binary> is the main executable (termihub, termihub.exe, or
# termiHub.app/Contents/MacOS/termihub). The bundled runner must sit in the same
# directory as termihub-plugin-runner[.exe] (Tauri `externalBin`; --runner
# names it elsewhere, e.g. the staged file of a `--no-bundle` build), and:
#   1. be an executable file;
#   2. start on this machine: a wrong `--protocol` must exit with the runner's
#      usage code 64, not a loader/arch failure (skip with --no-run, e.g. for a
#      cross-built bundle the runner cannot execute);
#   3. hash to a SHA-256 embedded in <app-binary>. core/build.rs embeds the
#      staged runner's digest and the app refuses a bundled runner that does
#      not match it, so this catches a bundling or signing step that rewrote
#      the file after staging.
#
# Exit status: 0 = all checks passed, 1 = a check failed, 2 = usage error.
# Runs in release.yml / dev-build.yml, the release install smokes and
# release-check.sh; check-script-headless.sh runs it against stubs per PR.

set -euo pipefail

# Byte-wise matching: the app binary is not valid UTF-8.
export LC_ALL=C

# The runner's usage exit code (plugin-runner/src/runner/mod.rs, exit::USAGE).
USAGE_EXIT=64

usage() {
    sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

RUN=1
APP=""
RUNNER=""
while [ $# -gt 0 ]; do
    case "$1" in
    --help | -h)
        usage
        exit 0
        ;;
    --no-run)
        RUN=0
        shift
        ;;
    --runner)
        RUNNER="${2:?--runner requires a path}"
        shift 2
        ;;
    -*)
        echo "Unknown argument: $1" >&2
        exit 2
        ;;
    *)
        if [ -n "$APP" ]; then
            echo "Only one <app-binary> is accepted" >&2
            exit 2
        fi
        APP="$1"
        shift
        ;;
    esac
done

if [ -z "$APP" ]; then
    echo "usage: $0 [--no-run] [--runner <path>] <app-binary>" >&2
    exit 2
fi
if [ ! -f "$APP" ]; then
    echo "::error::app binary not found: $APP"
    exit 1
fi

if [ -z "$RUNNER" ]; then
    case "$APP" in
    *.exe | *.EXE) RUNNER="$(dirname "$APP")/termihub-plugin-runner.exe" ;;
    *) RUNNER="$(dirname "$APP")/termihub-plugin-runner" ;;
    esac
fi

if [ ! -f "$RUNNER" ] || [ ! -x "$RUNNER" ]; then
    echo "::error::bundled plugin runner missing or not executable at $RUNNER"
    exit 1
fi
echo "plugin runner: $RUNNER"

if [ "$RUN" -eq 1 ]; then
    # A missing VC++ runtime, a wrong architecture or a broken signature makes
    # the OS refuse to start it; the runner itself answers with its usage code.
    rc=0
    if command -v timeout >/dev/null 2>&1; then
        timeout 30 "$RUNNER" --protocol 0 >/dev/null 2>&1 || rc=$?
    else
        # macOS has no coreutils `timeout`; perl's alarm is the portable stand-in.
        perl -e 'alarm shift; exec @ARGV' 30 "$RUNNER" --protocol 0 >/dev/null 2>&1 || rc=$?
    fi
    if [ "$rc" -ne "$USAGE_EXIT" ]; then
        echo "::error::plugin runner answered '--protocol 0' with exit $rc, expected $USAGE_EXIT"
        exit 1
    fi
    echo "  starts: '--protocol 0' -> exit $rc (usage), as expected"
fi

if command -v sha256sum >/dev/null 2>&1; then
    DIGEST="$(sha256sum "$RUNNER" | cut -c1-64)"
else
    DIGEST="$(shasum -a 256 "$RUNNER" | cut -c1-64)"
fi
case "$DIGEST" in
*[!0-9a-f]* | "")
    echo "::error::could not hash $RUNNER (got '$DIGEST')"
    exit 1
    ;;
esac
if ! grep -qaF "$DIGEST" "$APP"; then
    echo "::error::the runner's SHA-256 $DIGEST is not embedded in $APP; the app would refuse" \
        "it as tampered. Was it rewritten after staging (signing, bundling), or was the app" \
        "built without staging it (scripts/build-plugin-runner.sh --tauri-externalbin)?"
    exit 1
fi
echo "  integrity: SHA-256 $DIGEST is the digest embedded in $(basename "$APP")"
echo "Plugin runner bundle OK."
