# First-Class SSH Jump Host / Gateway in Connection Editor

**GitHub Issues:** [#520](https://github.com/armaxri/termiHub/issues/520) (original gateway/UI concept),
[#872](https://github.com/armaxri/termiHub/issues/872) (ProxyJump connect path + `SSH-JUMP-01` test conversion)

> **Folder-form concept** (AI-driven concept workflow). Visual surfaces live in
> [`mockups/`](mockups/), behavior diagrams in [`behavior.md`](behavior.md), and the
> concept↔code reconciliation ledger in [`sync.md`](sync.md). The concept is the source of
> truth; run `/sync-concept ssh-jump-host` to reconcile it with the implementation.

---

## Overview

Add a first-class SSH gateway / jump host option directly in the SSH connection editor, allowing users to configure proxy hops without deploying the remote agent. This brings termiHub in line with MobaXterm's SSH gateway feature and OpenSSH's `ProxyJump` directive.

**Motivation**: termiHub currently supports SSH jump hosts only through the remote agent's sub-sessions, which requires agent deployment on the bastion host. Many users need simple `ProxyJump` / `ProxyCommand` functionality to reach servers behind a bastion host without that overhead. This is one of the most common SSH workflows in enterprise environments.

### Goals

- Allow users to select an SSH gateway per connection in the connection editor UI
- Support both referencing an existing saved SSH connection and inline gateway configuration
- Support multi-hop chaining (gateway -> gateway -> target)
- Integrate with the credential store for per-hop authentication
- Pool gateway sessions across multiple connections sharing the same jump host
- Ensure SSH tunnels work through jump hosts

### Non-Goals

- Replacing the remote agent for advanced features (file browsing, monitoring, Docker sessions)
- Automatic detection of bastion hosts from `~/.ssh/config` (future enhancement)
- SOCKS proxy or HTTP CONNECT proxy support (separate feature)
- Jump hosts for non-SSH connection types (serial, telnet, local shell)

---

## UI Interface

The visual surfaces are specified by the mockups — open them in a browser to review layout and
states. This section describes them; the mockups are authoritative for layout.

| Mockup                                                                           | Shows                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`mockups/ssh-jump-host-editor.html`](mockups/ssh-jump-host-editor.html)         | Connection editor "Jump Host" category: disabled, saved-connection mode, inline mode, multi-hop + error |
| [`mockups/ssh-jump-host-indicators.html`](mockups/ssh-jump-host-indicators.html) | Sidebar hop badges + tooltip, status-bar hop-chain display, and the jump-host context menu              |

### Connection Editor — Jump Host Section

A **"Jump Host"** section appears in the SSH connection editor as a flat category
(`settings-panel__category`, the same pattern as the other editor categories — "General",
"SSH Agent", "Session"), after the connection/authentication fields and before the SSH Agent
category. A single **"Connect through a jump host"** checkbox (with the `ArrowLeftRight` icon)
reveals the body. The section has no separate "Advanced" group and is not a collapsible chevron
group — the connection editor uses flat categories throughout. See
`mockups/ssh-jump-host-editor.html` states 1–4.

Each hop carries a **source segmented control** ("Saved connection" / "Inline configuration")
selecting one of the two modes below. The "Saved connection" option is disabled when there are no
other SSH connections to reference. A per-hop **Connect Timeout (s)** field applies to either mode
(blank = the default SSH connect timeout).

#### Mode 1: Saved Connection Reference

The user selects an existing SSH connection from a dropdown. This is the quickest option when the
bastion host is already configured as a saved connection. The dropdown only shows SSH-type saved
connections and displays the full path (`folder / sub / name`) to disambiguate connections with the
same name; the connection being edited is excluded so it cannot reference itself. A reference whose
target was deleted/renamed is shown as `… (not found)` and flagged by validation. See state 2.

#### Mode 2: Inline Configuration

The user configures the gateway directly within the connection editor (host, port, username, auth
method, key/password), without needing a separate saved connection. Useful for one-off gateways or
when the bastion host isn't worth saving standalone. See state 3.

#### Multi-Hop Chaining

Clicking "Add another hop" appends an additional jump host entry. A lone hop renders as a plain
field group; as soon as there are two or more hops, each renders as a **numbered, removable hop
card** ("Hop 1 (outermost)", "Hop 2 (intermediate)", …, "Hop N (innermost)") with its own Remove
control. Hops are ordered from outermost (first connection) to innermost (closest to target). A
**"Connection path"** summary line (`You → edge-gateway → internal-bastion → target`) provides a
visual summary of the full hop chain for easy verification, with the target node in the accent
color. Non-blocking **warnings** (e.g. deep chains) appear as hints; when the chain is invalid
(missing/deleted reference, circular reference, missing inline host/username), an inline
**validation error** block is shown in the error color and Save is blocked. See state 4.

### Connection Sidebar — Visual Indicator

Connections configured with a jump host display a small lucide hop icon (`arrow-left-right`) next to
the connection icon in the connection tree sidebar. Hovering shows a tooltip with the full path
(`Via: bastion.example.com → target`). Multi-hop connections add a small hop-count label. See
`mockups/ssh-jump-host-indicators.html` section A.

### Status Bar — Connection Info

When a terminal tab using a jump host is active, the status bar shows the hop chain
(`SSH: deploy@app-server via bastion.example.com`). See `mockups/ssh-jump-host-indicators.html`
section B.

### Connection Context Menu

Right-clicking a connection that uses a jump host shows additional context actions:

- **Open Jump Host Terminal** — opens a terminal directly on the gateway (useful for debugging
  connectivity)
- **Show Connection Path** — displays a popover with the full hop chain and per-hop status

See `mockups/ssh-jump-host-indicators.html` section C.

---

## General Handling

Detailed flows, the per-hop authentication path, session pooling, tunnel compatibility, the jump
host state machine, single- and multi-hop sequences, and the on-save validation flow are all
diagrammed in [`behavior.md`](behavior.md). Key rules:

### Relationship with Remote Agent

Jump host (simple forwarding) and remote agent (full capabilities) serve different needs. The UI
should make the distinction clear:

| Capability                  | Jump Host Only   | Remote Agent           |
| --------------------------- | ---------------- | ---------------------- |
| Shell access to target      | Yes              | Yes                    |
| File browsing (SFTP)        | Yes (via target) | Yes (via agent)        |
| System monitoring           | No               | Yes                    |
| Docker sessions on target   | No               | Yes                    |
| Sub-sessions from target    | No               | Yes                    |
| Agent deployment required   | No               | Yes                    |
| Connection overhead         | Minimal          | Higher (agent process) |
| Works with restricted hosts | Yes (no install) | Requires write access  |

When a user configures both a jump host AND agent deployment, the agent is deployed through the jump
host tunnel — the jump host provides the transport, and the agent provides the features.

### Edge Cases & Error Handling

| Scenario                                            | Handling                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Jump host unreachable                               | Show error: "Cannot reach jump host `bastion.example.com:22`. Check network connectivity."                     |
| Jump host auth fails                                | Show error specifying which hop failed: "Authentication failed on hop 1 (bastion.example.com)"                 |
| Target unreachable from jump host                   | Show error: "Jump host connected, but target `app-server:22` is unreachable from `bastion.example.com`"        |
| Target auth fails (after successful hop)            | Show error: "Connected via jump host. Authentication failed on target `app-server`"                            |
| Jump host session drops                             | All connections through that gateway disconnect. Show reconnection dialog per connection.                      |
| Referenced saved connection deleted                 | Show warning when deleting: "This connection is used as a jump host by N other connections." Block or confirm. |
| Referenced saved connection modified                | Changes to the gateway connection automatically apply to all connections using it as a jump host.              |
| Circular reference (A jumps through B, B through A) | Validate on save — reject circular jump host chains with clear error message.                                  |
| Jump host chain too deep (>5 hops)                  | Warn on save: "Chain has N hops. Deep chains may cause latency issues." Allow but warn.                        |
| Inline gateway password not saved                   | Prompt at connect time. Optionally save to credential store.                                                   |
| Connection timeout through hops                     | Per-hop timeout. Show which hop timed out.                                                                     |

### Reconnection Behavior

When a jump host connection drops mid-session:

1. All terminal sessions through that gateway are disconnected
2. Each terminal shows a reconnection banner: "Connection lost (jump host disconnected). [Reconnect]"
3. Clicking Reconnect re-establishes the full hop chain
4. The session pool creates a new gateway session on reconnection
5. If multiple terminals reconnect simultaneously, the pool ensures only one gateway session is created

---

## Preliminary Implementation Details

> Based on the current project architecture as of the time of concept creation. The codebase may evolve before implementation.

### Backend (Rust)

#### Core Config Extension (`core/src/config/mod.rs`)

`SshConfig` (currently at `core/src/config/mod.rs:230`) has **no** jump/proxy/bastion field today —
its fields are `host`, `port`, `username`, `auth_method`, `password`, `key_path`, `shell`, `cols`,
`rows`, `env`, `enable_x11_forwarding`, `enable_monitoring`, `enable_file_browser`, `save_password`,
`connect_timeout_secs`. Add jump host configuration:

```rust
/// Configuration for a single jump host hop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpHostConfig {
    /// Reference to a saved SSH connection ID (mutually exclusive with inline config).
    pub connection_id: Option<String>,
    /// Inline SSH configuration (used when connection_id is None).
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub auth_method: Option<String>,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub save_password: Option<bool>,
}

// Add to SshConfig:
pub struct SshConfig {
    // ... existing fields ...
    /// Optional jump host chain (ordered outermost to innermost), OpenSSH `-J` / `ProxyJump` style.
    #[serde(default, alias = "jumpHosts", skip_serializing_if = "Vec::is_empty")]
    pub proxy_jump: Vec<JumpHostConfig>,
}
```

> **Naming decision (#872):** The field is named **`proxy_jump`** (serialized `proxyJump`) to match
> OpenSSH's `ProxyJump` / `-J` directive, which is the term most SSH users already know. A serde
> `alias = "jumpHosts"` keeps the UI-facing label "Jump Host" working and tolerates the earlier
> draft name. The chain is ordered outermost→innermost (`-J edge,bastion` ⇒
> `[edge, bastion]`), exactly like `ssh -J`.

The `expand()` method on `SshConfig` (`core/src/config/mod.rs:388`) currently expands `${VAR}`/`~`
in `host`, `username`, `key_path`, and `password`. It must also expand those placeholders in each
inline `JumpHostConfig` hop's `host`, `username`, `key_path`, and `password`.

#### SSH Backend Modification (`core/src/backends/ssh/`)

> **Stack reality:** termiHub's SSH stack is **`russh 0.61`** (async, pure-Rust), _not_ the
> `ssh2`/libssh2 bindings. `SshSession` is `russh::client::Handle<TermiHubHandler>`
> (`core/src/backends/ssh/handler.rs`). This makes session-over-channel a **solved, already-used
> pattern** rather than a risk — see below.

The connect path already in the tree is `do_connect_and_authenticate()`
(`core/src/backends/ssh/auth.rs:76`), which:

1. opens a `tokio::net::TcpStream::connect(addr)` (auth.rs:83),
2. hands it to `russh::client::connect_stream(russh_config, tokio_tcp, handler)` (auth.rs:113), then
3. calls `authenticate(&mut session, config)` (auth.rs:117) — `agent`, `key` (with legacy-PEM-EC
   fallback), or `password`.

The **only** difference for a jump hop is _what stream_ step 2 runs over. russh's `connect_stream`
accepts any `AsyncRead + AsyncWrite + Unpin` — and a forwarded channel already exposes exactly that
via `channel.into_stream()`, the same call SFTP, X11, and every tunnel forwarder already use
(`auth.rs:113`, `files/sftp.rs:43`, `tunnel/local_forward.rs:150`, `tunnel/dynamic_forward.rs:186`,
`tunnel/remote_forward.rs:122`).

Refactor `do_connect_and_authenticate` so the transport is injectable, then add a channel variant —
no new crate, no custom `Read+Write` adapter:

```rust
/// Establish + authenticate a russh session over an existing forwarded channel
/// (opened with `channel_open_direct_tcpip` on the previous hop).
pub async fn connect_and_authenticate_over_channel(
    config: &SshConfig,
    channel: russh::Channel<russh::client::Msg>,
) -> Result<SshSession, SessionError> {
    let russh_config = build_client_config(config);
    let handler = TermiHubHandler::new(/* host key policy */);
    // channel.into_stream(): AsyncRead + AsyncWrite + Unpin — exactly what connect_stream wants.
    let mut session =
        russh::client::connect_stream(russh_config, channel.into_stream(), handler).await?;
    authenticate(&mut session, config).await?;
    Ok(session)
}
```

Add a new module `core/src/backends/ssh/jump_host.rs` that walks the chain:

```rust
/// Establish an SSH session through a chain of jump hosts.
/// Returns the authenticated russh session on the final target host.
pub async fn connect_through_jump_hosts(
    hops: &[ResolvedJumpHost], // ordered outermost → innermost
    target: &SshConfig,
) -> Result<SshSession, SessionError> {
    // 1. First hop: ordinary TCP connect + auth (reuse do_connect_and_authenticate).
    let mut session = do_connect_and_authenticate(&hops[0].config).await?;

    // 2. Each subsequent hop: open a direct-tcpip channel on the *current* session to the
    //    next hop's host:port, then handshake/auth the next session over that channel.
    for next in &hops[1..] {
        let channel = session
            .channel_open_direct_tcpip(&next.config.host, next.config.port as u32, "localhost", 0)
            .await?;
        session = connect_and_authenticate_over_channel(&next.config, channel).await?;
    }

    // 3. Final hop → target: direct-tcpip to the target, then auth the target session over it.
    let channel = session
        .channel_open_direct_tcpip(&target.host, target.port as u32, "localhost", 0)
        .await?;
    connect_and_authenticate_over_channel(target, channel).await
}
```

`channel_open_direct_tcpip` is the **identical primitive** the tunnel forwarders already call
(`tunnel/local_forward.rs:140`, `tunnel/dynamic_forward.rs:168`), so the building block is proven in
production code — this feature reuses it for the terminal connect path instead of duplicating it.

#### Session Pool Extension (`src-tauri/src/tunnel/session_pool.rs`)

The existing `SshSessionPool` already supports reference-counted session sharing. It needs to be extended:

1. **Shared between tunnels and terminal connections**: Currently only used by the tunnel manager. Make it accessible from the terminal connection path too.
2. **Jump host session tracking**: Pool entries keyed by connection ID. When a saved connection is used as a jump host, its session can be shared across all consumers.
3. **Intermediate hop sessions**: For multi-hop chains, intermediate sessions also need pooling.

```rust
/// Extended pool entry to track jump host intermediates.
/// (`SshSession` = `Arc<russh::client::Handle<TermiHubHandler>>`, the same handle type the
/// tunnel forwarders already pool — russh handles are cheaply cloneable and internally synced.)
struct PooledSession {
    session: SshSession,
    ref_count: usize,
    /// Sessions for intermediate hops (if this is a multi-hop chain).
    intermediate_sessions: Vec<SshSession>,
}
```

#### Connection Manager Changes (`src-tauri/src/connection/`)

- **Validation**: Add circular reference detection when saving a connection with jump host references
- **Deletion protection**: When deleting a saved connection, check if other connections reference it as a jump host. Warn user and optionally cascade-update or block deletion.
- **Resolution**: New method `resolve_jump_host_chain(connection_id) -> Vec<ResolvedJumpHost>` that follows the chain of connection references, loading inline or saved configs for each hop.

#### New and Modified Files

| File                                   | Change                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `core/src/config/mod.rs`               | **Modify** — Add `JumpHostConfig` struct + `proxy_jump` to `SshConfig`; expand inline hops                      |
| `core/src/backends/ssh/jump_host.rs`   | **New** — `connect_through_jump_hosts` (russh chain over `channel_open_direct_tcpip`)                           |
| `core/src/backends/ssh/mod.rs`         | **Modify** — Use jump host logic when `proxy_jump` is non-empty                                                 |
| `core/src/backends/ssh/auth.rs`        | **Modify** — Factor transport out of `do_connect_and_authenticate`; add `connect_and_authenticate_over_channel` |
| `src-tauri/src/tunnel/session_pool.rs` | **Modify** — Extend for shared use, intermediate session tracking                                               |
| `src-tauri/src/connection/manager.rs`  | **Modify** — Add chain resolution, deletion protection                                                          |
| `src-tauri/src/connection/config.rs`   | **Modify** — Validate jump host config on save                                                                  |
| `core/tests/ssh_advanced.rs`           | **Modify** — Convert `SSH-JUMP-01` to drive `connect_through_jump_hosts` end-to-end (see below)                 |

### Frontend (React/TypeScript)

#### Connection Editor Changes

The SSH connection settings carry a single `proxyJump` array of hop configs — there is **no**
separate `jumpHostEnabled` flag and **no** `source` discriminator field. Both are derived state:

- **Enabled** ⇔ the `proxyJump` array is non-empty. Ticking "Connect through a jump host" seeds one
  default inline hop; unticking clears the array (emits `undefined`).
- **Mode** ⇔ a hop is "saved" iff it carries a `connectionId`; otherwise it is "inline". Switching
  the source toggle sets/clears `connectionId` (and clears stale inline `host`/`username`).

```typescript
// In src/types/connection.ts — one entry per hop, ordered outermost → innermost.
interface JumpHostConfig {
  /** Reference to a saved SSH connection; present ⇒ "saved" mode, absent ⇒ "inline". */
  connectionId?: string;
  host: string;
  port: number;
  username: string;
  /** "key" | "password" | "agent". */
  authMethod: string;
  password?: string;
  keyPath?: string;
  /** Per-hop connect/handshake timeout (s); unset ⇒ default SSH connect timeout (#951). */
  connectTimeoutSecs?: number;
}

// SSH connection settings (no `jumpHostEnabled`): the chain lives in `proxyJump`.
interface SshConnectionConfig {
  // ... existing fields ...
  /** OpenSSH `-J` / ProxyJump chain; empty/absent ⇒ direct connection. */
  proxyJump?: JumpHostConfig[];
}
```

> The Rust model serializes the chain as `proxyJump` with a serde `alias = "jumpHosts"`; the
> frontend tolerates both keys (`getJumpHosts` in `src/utils/jumpHost.ts`).

#### New Components

```
src/components/ConnectionEditor/
  JumpHostSection.tsx        # Jump host editor category (enable checkbox, hops, path, validation)
  JumpHostEntry.tsx          # Single hop entry (source toggle + saved dropdown or inline fields)
  JumpHostPathDisplay.tsx    # Visual "You → hop1 → hop2 → target" display
src/utils/
  jumpHost.ts                # Chain extraction + display helpers (badge/status/path/gateway/deps)
  validateProxyJump.ts       # Save-time validation (inline fields, missing/non-SSH refs, cycles, depth)
```

`JumpHostSection.tsx` follows the flat `settings-panel__category` pattern used by the other editor
categories (General, SSH Agent, Session). Each `JumpHostEntry` renders the source segmented control
and then either a saved-connection dropdown or the inline SSH fields, plus the per-hop connect
timeout.

#### Sidebar Visual Indicator

The connection tree rendering in `src/components/Sidebar/ConnectionList.tsx` shows a hop badge
(lucide `ArrowLeftRight`) on connections whose config has a non-empty `proxyJump` chain, using the
`hasJumpHost` / `getJumpHosts` / `jumpHostTooltip` helpers from `src/utils/jumpHost.ts`. Multi-hop
connections add a small hop-count label:

```typescript
// In connection tree item rendering (ConnectionList.tsx)
{hasJumpHost(connection.config) && (
  <span
    className="connection-tree__jump-badge"
    title={jumpHostTooltip(getJumpHosts(connection.config), connection.name)}
  >
    <ArrowLeftRight size={12} />
    {hopCount > 1 && <span className="connection-tree__hop-count">{hopCount}</span>}
  </span>
)}
```

#### Store Changes (`src/store/appStore.ts`)

Minimal changes needed — the jump host config is part of the connection config and flows through existing save/load paths. The connection editor state already handles dynamic SSH settings.

#### API Layer (`src/services/api.ts`)

No new Tauri commands needed for jump host support — the jump host config is part of the SSH
connection config that flows through the existing connect command. The backend resolves and connects
through the chain internally (`src-tauri/src/connection/jump_host_resolver.rs`), and is the
authoritative safety net for cycles/missing references at connect time.

Save-time validation is done **client-side** by `validateProxyJump` (`src/utils/validateProxyJump.ts`)
rather than via a round-trip Tauri command — it returns `{ errors, warnings }`, where `errors` block
Save and `warnings` are advisory:

```typescript
export function validateProxyJump(
  hops: JumpHostConfig[],
  ctx?: { connections: SavedConnection[]; currentConnectionId?: string }
): { errors: string[]; warnings: string[] };
```

Reference and circular-chain checks run only when `ctx` (the saved connections) is supplied; inline
hops are validated for required host/username regardless.

#### Types (`src/types/connection.ts`)

Add jump host related types alongside existing connection types.

### Data Model & Storage

Jump host configuration is stored inline within the SSH connection config in `connections.json`:

```json
{
  "type": "ssh",
  "config": {
    "host": "app-server.internal",
    "port": 22,
    "username": "deploy",
    "authMethod": "key",
    "keyPath": "~/.ssh/id_ed25519",
    "jumpHostEnabled": true,
    "jumpHosts": [
      {
        "source": "saved",
        "connectionId": "Work/bastion.example.com"
      }
    ]
  }
}
```

For inline jump hosts:

```json
{
  "jumpHosts": [
    {
      "source": "inline",
      "host": "bastion.example.com",
      "port": 22,
      "username": "admin",
      "authMethod": "key",
      "keyPath": "~/.ssh/bastion_key"
    }
  ]
}
```

Inline jump host passwords follow the same credential store flow as regular SSH passwords — stored via the active credential store when `savePassword` is true.

### Testing — `SSH-JUMP-01` Conversion (#872)

The integration fixtures already exist and are wired for a real 2-hop jump:

- **Docker fixtures** (`tests/docker/docker-compose.yml`): `ssh-jumphost-bastion`
  (`termihub-ssh-bastion`, published on `127.0.0.1:2204`, on both `test-net` and `jumphost-net`) and
  `ssh-jumphost-target` (`termihub-ssh-target`, **no host port**, only on the isolated
  `jumphost-net`). The target is deliberately unreachable except _through_ the bastion — the exact
  topology a ProxyJump must traverse.
- **Current test** `ssh_jump_01_two_hop_proxy_jump` (`core/tests/ssh_advanced.rs:23`) proves only the
  building blocks: it (a) shells out to the system `ssh` binary _on the bastion_ to confirm the
  target is reachable, and (b) calls the raw `channel_open_direct_tcpip("termihub-ssh-target", 22,
…)` primitive. Neither path goes through a termiHub jump connection a user could configure.

**Conversion plan:** rewrite (or add a sibling to) `SSH-JUMP-01` so it drives termiHub's own
`connect_through_jump_hosts` end-to-end:

1. Build an `SshConfig` for the **target** (`termihub-ssh-target:22`) carrying a one-hop
   `proxy_jump` chain whose inline `JumpHostConfig` points at the **bastion**
   (`127.0.0.1:2204`, ed25519 key).
2. Call `connect_through_jump_hosts(&hops, &target)` and assert it returns an authenticated session
   **on the target** — something only reachable via the bastion, so success proves the hop actually
   forwarded.
3. Open a shell/exec channel on the returned session and assert it reads the target's
   `marker.txt`, replacing the `ssh`-shell-out reachability check.
4. Keep the raw `channel_open_direct_tcpip` assertion as a lower-level regression guard.

This converts the test from "the primitive works" to "a user-configurable termiHub jump connection
works", closing the gap #872 identifies. The test is gated behind the same Docker-fixtures feature
flag as the rest of `ssh_advanced.rs`.

### Implementation Phases

1. **Phase 1 — Core backend**: Add `JumpHostConfig` + `proxy_jump` to `SshConfig`. Factor the
   transport out of `do_connect_and_authenticate` and add `connect_and_authenticate_over_channel`
   (russh `connect_stream` over `channel.into_stream()`). Implement `connect_through_jump_hosts` for
   single-hop. Convert `SSH-JUMP-01` (`core/tests/ssh_advanced.rs`) to drive it end-to-end through
   the bastion/target Docker fixtures (see Testing above).

2. **Phase 2 — Connection editor UI**: Add `JumpHostSection` component. Implement saved-connection dropdown and inline config mode. Wire to existing save/load paths.

3. **Phase 3 — Session pooling**: Extend `SshSessionPool` for shared jump host → terminal use. Ensure tunnels through jump hosts also pool correctly. Add reference counting for intermediate hops.

4. **Phase 4 — Multi-hop support**: Extend Phase 1 for N-hop chains. Add "Add another hop" UI. Implement chain validation (circular refs, depth warnings).

5. **Phase 5 — Visual indicators & polish**: Add sidebar hop badges. Add status bar connection path display. Add context menu actions (Open Jump Host Terminal, Show Connection Path). Handle reconnection through jump hosts.

### Technical Risks

| Risk                                                | Mitigation                                                                                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session-over-channel transport                      | **Resolved by stack** — russh's `connect_stream` accepts the `AsyncRead+AsyncWrite` from `channel.into_stream()`; already used by SFTP/X11/tunnels (`auth.rs:113`, `local_forward.rs:150`). No custom adapter needed. |
| Pooled jump host session becomes stale              | Add keepalive pings to pooled sessions. Detect disconnection and trigger reconnection for all users.                                                                                                                  |
| Credential prompting for multiple hops is confusing | Show clear hop labels in password dialogs: "Password for hop 1 (bastion.example.com)"                                                                                                                                 |
| Performance with deep chains                        | Cap default at 5 hops with warning. Each hop adds ~100ms latency for handshake.                                                                                                                                       |

---

## Implementation Status

Substantially implemented. The core connect path (russh chain over `channel_open_direct_tcpip`),
session pooling (#924), the connection-editor "Jump Host" category with saved/inline modes,
multi-hop cards, per-hop connect timeout (#951), client-side validation, deletion protection
(#941), and the visual indicators (sidebar badge, status-bar chain, context menu, connection-path
dialog) have shipped. The editor UI was reconciled with these artifacts in #937 (see
[`sync.md`](sync.md), Resolved R1–R5). Remaining open items are connect-time per-hop error UX and
the per-terminal reconnection banner (tracked in [`sync.md`](sync.md) Open divergences). Run
`/sync-concept ssh-jump-host` after each further change to keep [`sync.md`](sync.md) current.
