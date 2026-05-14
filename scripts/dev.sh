#!/usr/bin/env bash
# Start the app in development mode with hot-reload.
# Run from anywhere: ./scripts/dev.sh [PORT]
#
# All per-checkout settings live in dev.local.json (gitignored):
#   {
#     "dev_port": 1422,          -- Vite dev server port (default: 1420)
#     "dev_agent_port": 2222     -- auto-start local sshd for agent testing (Unix only)
#     "dev_name": "dev0"         -- label for the agent entry in termiHub sidebar (optional)
#   }
# Each workspace gets a port-scoped agent ID so parallel workspaces coexist.
#
# Port resolution order (first match wins):
#   1. CLI argument:           ./scripts/dev.sh 1422
#   2. dev.local.json          { "dev_port": 1422 }
#   3. dev.local (legacy)      echo 1422 > dev.local
#   4. Default:                1420
#
# Dev agent: when dev_agent_port is set, a local sshd starts on 127.0.0.1:<port>
# and is killed automatically when dev.sh exits. Add a termiHub agent connection once:
#   host=127.0.0.1  port=<dev_agent_port>  user=$USER  key=~/.ssh/id_rsa
#   agent binary: <repo>/agent/target/debug/termihub-agent
#
# Multiple instances can run in parallel by using different ports.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Resolve dev port
DEV_PORT=1420
if [ -n "${1:-}" ] && [[ "$1" =~ ^[0-9]+$ ]]; then
    DEV_PORT="$1"
elif [ -f "dev.local.json" ]; then
    _CONF_PORT=$(grep -oE '"dev_port"[[:space:]]*:[[:space:]]*[0-9]+' dev.local.json | grep -oE '[0-9]+$' || true)
    if [[ "${_CONF_PORT:-}" =~ ^[0-9]+$ ]]; then
        DEV_PORT="$_CONF_PORT"
    fi
elif [ -f "dev.local" ]; then
    _CONF_PORT="$(tr -d '[:space:]' < dev.local)"
    if [[ "$_CONF_PORT" =~ ^[0-9]+$ ]]; then
        DEV_PORT="$_CONF_PORT"
    fi
fi

# --- Optional dev agent via local sshd (Unix only) ---
_DEV_AGENT_DIR=""

_stop_dev_agent() {
    if [ -n "$_DEV_AGENT_DIR" ] && [ -f "$_DEV_AGENT_DIR/sshd.pid" ]; then
        kill "$(cat "$_DEV_AGENT_DIR/sshd.pid")" 2>/dev/null || true
        rm -rf "$_DEV_AGENT_DIR"
        echo "Dev agent sshd stopped."
    fi
}
trap _stop_dev_agent EXIT

# Upsert the dev agent entry in termiHub's connections.json so no manual UI setup
# is needed. ID is port-scoped so parallel workspaces each get their own entry.
_upsert_dev_agent_connection() {
    local port="$1" key_path="$2" agent_binary="$3" label="$4"
    if [[ "$(uname)" == "Darwin" ]]; then
        local cfg_dir="$HOME/Library/Application Support/com.termihub.app"
    else
        local cfg_dir="${XDG_CONFIG_HOME:-$HOME/.config}/com.termihub.app"
    fi
    python3 - "$cfg_dir/connections.json" "$port" "$USER" "$key_path" "$agent_binary" "$label" << 'PYEOF'
import json, sys, os
conn_file, port, username, key_path, agent_binary, label = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
agent_id = f"dev-local-agent-{port}"
agent_name = f"Dev Agent ({label})" if label else f"Dev Agent (:{port})"
os.makedirs(os.path.dirname(conn_file), exist_ok=True)
data = json.load(open(conn_file)) if os.path.exists(conn_file) else {"version": "2", "children": [], "agents": []}
if "agents" not in data:
    data["agents"] = []
entry = {
    "id": agent_id, "name": agent_name,
    "config": {"host": "127.0.0.1", "port": port, "username": username,
               "authMethod": "key", "keyPath": key_path, "agentPath": agent_binary},
    "agentSettings": {"enableMonitoring": True, "enableFileBrowser": True,
                      "enableDocker": True, "startingDirectory": "~",
                      "logLevel": "info", "verboseTracing": False,
                      "persistentScrollbackBufferSizeMb": 1}
}
idx = next((i for i, a in enumerate(data["agents"]) if a.get("id") == agent_id), None)
if idx is not None:
    data["agents"][idx]["name"] = agent_name
    data["agents"][idx]["config"].update({"port": port, "keyPath": key_path, "agentPath": agent_binary})
else:
    data["agents"].append(entry)
with open(conn_file, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF
}

if [ -f "dev.local.json" ]; then
    _DEV_AGENT_PORT=$(grep -oE '"dev_agent_port"[[:space:]]*:[[:space:]]*[0-9]+' dev.local.json | grep -oE '[0-9]+$' || true)
    _DEV_NAME=$(grep -oE '"dev_name"[[:space:]]*:[[:space:]]*"[^"]+"' dev.local.json | grep -oE '"[^"]+"$' | tr -d '"' || true)
    if [[ "${_DEV_AGENT_PORT:-}" =~ ^[0-9]+$ ]]; then
        _SSHD=""
        for _p in /usr/sbin/sshd /sbin/sshd; do
            [ -x "$_p" ] && _SSHD="$_p" && break
        done
        if [ -z "$_SSHD" ]; then
            echo "Warning: dev_agent_port set but sshd not found — skipping dev agent."
        else
            # Stable key pair in .dev-agent/ (gitignored) so the connection entry
            # stays valid across restarts without reconfiguring termiHub.
            _DEV_KEYS_DIR="$(pwd)/.dev-agent"
            mkdir -p "$_DEV_KEYS_DIR"
            chmod 700 "$_DEV_KEYS_DIR"
            if [ ! -f "$_DEV_KEYS_DIR/client_key" ]; then
                ssh-keygen -t ed25519 -f "$_DEV_KEYS_DIR/client_key" -N "" -q
                echo "Generated dev agent SSH key: $_DEV_KEYS_DIR/client_key"
            fi
            chmod 600 "$_DEV_KEYS_DIR/client_key"
            chmod 644 "$_DEV_KEYS_DIR/client_key.pub"

            echo "Building agent binary..."
            cargo build -p termihub-agent
            _AGENT_BINARY="$(pwd)/target/debug/termihub-agent"

            _DEV_AGENT_DIR=$(mktemp -d /tmp/termihub-dev-sshd.XXXX)
            ssh-keygen -t ed25519 -f "$_DEV_AGENT_DIR/host_key" -N "" -q
            cat > "$_DEV_AGENT_DIR/sshd_config" << SSHD_EOF
Port $_DEV_AGENT_PORT
ListenAddress 127.0.0.1
HostKey $_DEV_AGENT_DIR/host_key
AuthorizedKeysFile $_DEV_KEYS_DIR/client_key.pub
PidFile $_DEV_AGENT_DIR/sshd.pid
UsePAM no
PasswordAuthentication no
StrictModes no
SSHD_EOF
            "$_SSHD" -f "$_DEV_AGENT_DIR/sshd_config"

            _upsert_dev_agent_connection "$_DEV_AGENT_PORT" "$_DEV_KEYS_DIR/client_key" "$_AGENT_BINARY" "${_DEV_NAME:-}"
            echo "Dev agent sshd listening on 127.0.0.1:$_DEV_AGENT_PORT (connection registered in termiHub)"
        fi
    fi
fi

if [ ! -d node_modules ]; then
    echo "node_modules missing, running pnpm install..."
    pnpm install
    echo ""
fi

# Kill any process occupying the Vite dev server port (leftover from a previous run)
node scripts/internal/kill-port.cjs "$DEV_PORT"

echo "Starting termiHub in dev mode (port $DEV_PORT)..."
TERMIHUB_DEV_PORT="$DEV_PORT" pnpm tauri dev --config "{\"build\":{\"devUrl\":\"http://localhost:$DEV_PORT\"}}"
