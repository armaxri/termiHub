#!/usr/bin/env bash
# Resolve per-checkout test settings from dev.local.json into environment
# variables, so every test entry point (test-system*.sh, test.sh, the E2E
# runner) isolates its host resources and several checkouts can run all of their
# test environments at once without conflict.
#
# SOURCE this file — do not execute it:
#     source "$(git rev-parse --show-toplevel)/scripts/internal/dev-local-env.sh"
#
# This is the shell mirror of termihub_harness/dev_local.py; both read the same
# dev.local.json keys (compose_project, test_port_offset) and apply the same
# defaults. Precedence per value: an already-set environment variable wins, then
# dev.local.json, then the built-in default (which reproduces single-checkout
# behaviour). See docs/testing.md → "Parallel test isolation".

_thdl_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
_thdl_file="$_thdl_root/dev.local.json"

# Echo a JSON key's value (string or number) from dev.local.json, or nothing.
_thdl_read() {
    local key="$1"
    [ -f "$_thdl_file" ] || return 0
    if command -v jq >/dev/null 2>&1; then
        jq -r --arg k "$key" '.[$k] // empty' "$_thdl_file" 2>/dev/null
    else
        # First `"key": <number>` or `"key": "string"`, unquoted.
        grep -oE "\"$key\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|[0-9]+)" "$_thdl_file" \
            | head -1 | sed -E 's/.*:[[:space:]]*//; s/^"//; s/"$//'
    fi
}

# Port offset and Compose project (env > file > default).
if [ -z "${TERMIHUB_TEST_PORT_OFFSET:-}" ]; then
    _thdl_off="$(_thdl_read test_port_offset)"
    [[ "$_thdl_off" =~ ^[0-9]+$ ]] || _thdl_off=0
    export TERMIHUB_TEST_PORT_OFFSET="$_thdl_off"
fi
if [ -z "${TERMIHUB_TEST_PROJECT:-}" ]; then
    _thdl_proj="$(_thdl_read compose_project)"
    [ -n "$_thdl_proj" ] || _thdl_proj="termihub"
    export TERMIHUB_TEST_PROJECT="$_thdl_proj"
fi
# COMPOSE_PROJECT_NAME groups containers (up/down/ps); TERMIHUB_TEST_PROJECT is
# what docker-compose.yml interpolates into names (a dedicated var keeps the
# :-termihub default intact for a bare `docker compose up`).
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$TERMIHUB_TEST_PROJECT}"

# Each published/looked-up container port = base + offset, unless already set.
_thdl_port() {
    local var="$1" base="$2"
    [ -z "${!var:-}" ] && export "$var"="$((base + TERMIHUB_TEST_PORT_OFFSET))"
}
_thdl_port TERMIHUB_TEST_SSH_PASSWORD_PORT   2201
_thdl_port TERMIHUB_TEST_SSH_SUDO_PORT       2212
_thdl_port TERMIHUB_TEST_SSH_NOSUDO_PORT     2213
_thdl_port TERMIHUB_TEST_SSH_LEGACY_PORT     2202
_thdl_port TERMIHUB_TEST_SSH_KEYS_PORT       2203
_thdl_port TERMIHUB_TEST_SSH_BASTION_PORT    2204
_thdl_port TERMIHUB_TEST_SSH_RESTRICTED_PORT 2205
_thdl_port TERMIHUB_TEST_SSH_BANNER_PORT     2206
_thdl_port TERMIHUB_TEST_SSH_TUNNEL_PORT     2207
_thdl_port TERMIHUB_TEST_SSH_X11_PORT        2208
_thdl_port TERMIHUB_TEST_NETWORK_FAULT_PORT  2209
_thdl_port TERMIHUB_TEST_SFTP_STRESS_PORT    2210
_thdl_port TERMIHUB_TEST_REMOTE_AGENT_PORT   2211
_thdl_port TERMIHUB_TEST_TELNET_PORT         2301
_thdl_port TERMIHUB_TEST_VNC_PORT            2501
_thdl_port TERMIHUB_TEST_VNC_VENCRYPT_PORT   2502
_thdl_port TERMIHUB_TEST_NETWORK_TARGET_PORT 8080
# FTP fixtures (tests/docker/ftp-server). Control ports plus two passive-port
# ranges; the ranges are advertised 1:1, so both the min AND max of each range
# are offset in lockstep with the control ports.
_thdl_port TERMIHUB_TEST_FTP_PORT                  2401
_thdl_port TERMIHUB_TEST_FTPS_IMPLICIT_PORT        2402
_thdl_port TERMIHUB_TEST_FTP_PASV_MIN              30000
_thdl_port TERMIHUB_TEST_FTP_PASV_MAX              30009
_thdl_port TERMIHUB_TEST_FTPS_IMPLICIT_PASV_MIN    30010
_thdl_port TERMIHUB_TEST_FTPS_IMPLICIT_PASV_MAX    30019
# examples/docker quick-start dev target (examples/docker/docker-compose.yml).
# SSH sits at 2214 — just past the SSH cluster (2201-2213) — so it never
# collides with the dev agent's conventional 2222 (`dev_agent_port`), which at
# test_port_offset 0 would otherwise want the same host port (#1536).
_thdl_port TERMIHUB_TEST_E2E_SSH_PORT        2214
_thdl_port TERMIHUB_TEST_E2E_TELNET_PORT     2323

# Virtual serial device paths — suffixed with the project so two checkouts'
# socat PTYs never collide on the same /tmp path.
export TERMIHUB_SERIAL_A="${TERMIHUB_SERIAL_A:-/tmp/termihub-serial-a-$TERMIHUB_TEST_PROJECT}"
export TERMIHUB_SERIAL_B="${TERMIHUB_SERIAL_B:-/tmp/termihub-serial-b-$TERMIHUB_TEST_PROJECT}"

# E2E WebDriver (tauri-driver) port.
export TERMIHUB_TAURI_DRIVER_PORT="${TERMIHUB_TAURI_DRIVER_PORT:-$((4444 + TERMIHUB_TEST_PORT_OFFSET))}"

unset _thdl_root _thdl_file _thdl_off _thdl_proj
