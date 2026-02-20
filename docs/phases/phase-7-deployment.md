# Phase 7: Agent Deployment & Updates

**Status: Completed**

---

## Summary

Implement the auto-deployment and update flow for the agent binary. When the desktop connects to a remote host via SSH, it checks for the agent, deploys it if missing, and updates it if the version is incompatible. This is primarily a desktop-side feature with minimal agent changes.

## Deployment Flow

1. Desktop SSH-connects to host
2. Runs `termihub-agent --version` to check for existing agent
3. If missing or version mismatch:
   - Show deployment dialog to user
   - Detect target architecture via `uname -m`
   - Download matching binary from GitHub Releases (or use bundled binary in dev)
   - SFTP upload to `~/.local/bin/termihub-agent`
   - `chmod +x`
4. Start agent: `termihub-agent --stdio`
5. Proceed with JSON-RPC handshake

## Update Flow

1. Desktop connects and gets `agent_version` from `initialize` response
2. If version incompatible:
   - Send `agent.shutdown` (graceful — agent detaches from all daemons, saves state)
   - Upload new binary
   - Start new agent
   - New agent recovers orphaned sessions from state.json + daemon sockets

## Version Matching Strategy

- Same major version required
- Agent minor version >= desktop expected minor
- Development builds bundle the agent binary for the developer's architecture

## Architecture Detection

Map `uname -m` output to binary targets:
- `x86_64` → `linux-x86_64`
- `aarch64` → `linux-aarch64`
- `armv7l` → `linux-armv7`
- `arm64` (macOS) → `darwin-aarch64`

## Protocol Methods Needed

```
agent.shutdown  → Graceful shutdown (orphan sessions to daemons, save state)
agent.update    → Prepare for update (same as shutdown + update intent)
```

## Files to Change

| File | Action | Description |
|------|--------|-------------|
| `agent/src/protocol/methods.rs` | Edit | Add `agent.shutdown` method types |
| `agent/src/handler/dispatch.rs` | Edit | Handle `agent.shutdown` |
| `src-tauri/src/terminal/agent_manager.rs` | Edit | Add deployment/update logic |
| `src-tauri/src/terminal/agent_deploy.rs` | New | Binary download, upload, version check |
| CI/build pipeline | Edit | Build agent for multiple architectures |

## Dependencies

- All previous phases should be stable before auto-deploying
- GitHub Releases infrastructure for binary distribution
- CI pipeline for cross-compilation (x86_64, aarch64, armv7)
