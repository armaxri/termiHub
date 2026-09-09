# Connection-type parity & consistency — audit summary

**Angle:** cross-backend parity matrix and consistency (not per-feature completeness — that is
covered under `audit/product-completeness/`). Focus: which capabilities each backend supports,
where one lags others without a good protocol reason, and where config / errors / behaviour are
modelled inconsistently across types.

**Scope reviewed:** `core/src/backends/{local_shell,serial,telnet,ssh,docker,wsl,ftp,vnc,rdp_sidecar,mock_remote_desktop}`,
`core/src/connection` (traits, registry, graphical trait, schema), `core/src/session`,
`core/src/files`, `core/src/tunnel`, `core/src/monitoring`, desktop registration
(`src-tauri/src/session/registry.rs`), agent registration (`agent/src/registry.rs`),
transfer subsystem (`src-tauri/src/files/transfer`), and the frontend schema/gating
(`src/utils/experimentalTypes.ts`, `src/types/connection.ts`).

## How parity is (and isn't) enforced

There are **two independent capability traits**, not one:

- `ConnectionType` (`core/src/connection/mod.rs`) — the byte-stream/terminal surface: `connect`,
  `disconnect`, `write`, `resize`, `subscribe_output`, plus optional `monitoring()`,
  `file_browser()`, `graphical()`.
- `GraphicalBackend` (`core/src/connection/graphical.rs`) — the framebuffer surface for
  remote-desktop types, reached via `ConnectionType::graphical()`.

A `Capabilities` struct (`monitoring / file_browser / graphical / resize / persistent / terminal`)
is **self-reported** by each backend and is purely advisory — the trait still forces every backend
to implement `write`/`resize`/`subscribe_output` even when they are meaningless (FTP/VNC/RDP return
`Ok(())` no-ops or closed channels). So "parity" is a matter of convention per backend, not a
compiler-enforced contract. This is why several capabilities drift silently (see findings).

## Capability × backend matrix

Legend: **●** full · **◐** partial / caveated · **○** none / no-op · **n/a** not applicable to the protocol.
Backends are the ten registered types. `wsl` is Windows-only; `vnc`/`rdp`/`mock` are graphical and
experimental-gated (`#1705`).

| Capability | local | serial | ssh | telnet | docker | wsl | ftp | vnc | rdp | mock |
|---|---|---|---|---|---|---|---|---|---|---|
| Interactive terminal (`terminal`) | ● | ● | ● | ● | ● | ● | ○ | n/a | n/a | n/a |
| Terminal resize (`resize`) | ● | ○ | ● | ○ | ● | ● | n/a | ◐ canvas-scale | ● dynamic | ○ |
| Graphical framebuffer | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ● | ● | ● |
| File browser (`file_browser`) | ● | ○ | ● SFTP | ○ | ● exec | ● | ● | ○ | ○ (clip-file only) | ○ |
| File transfer w/ progress+cancel | ○ | n/a | ● (cancel only) | n/a | ○ (whole-file) | ○ | ● (pause/resume/retry) | n/a | n/a | n/a |
| Transfer **pause/resume/auto-retry** | ○ | n/a | ○ | n/a | ○ | ○ | ● | n/a | n/a | n/a |
| Monitoring (`monitoring`) | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Port-forward / tunnels | ○ | n/a | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Auth methods | none | none | key/password/agent | none | none | none | anon/user-pass | none/password/user-pass | user-pass/NLA | none |
| Persistent across agent reconnect (`persistent`) | ● | ● | ● | ○ | ● | ● | ○ | ○ | ○ | ○ |
| Mid-connect cancellation (`connect_cancellable`) | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Connect-timeout config field | ○ | n/a | ● `connectTimeoutSecs` | ○ | ○ | ○ | ● `timeoutSecs` | ○ | ○ | ○ |
| Auto/resilient reconnect option | ○ | ○ | ◐ `resilientReconnect` (off) | ○ | ○ | ○ | ◐ silent NOOP | ● `autoReconnect` (on, max 3) | ● `autoReconnect` (on, max 3) | ● |
| **Available via remote agent** | ● | ● | ● | ● | ● | ● | ○ | ○ | ○ | ○ |

## Biggest asymmetries (ranked)

1. **Agent-hosted connections are a strict subset of desktop ones (PARITY-003, high).** The agent
   registry registers only local/serial/ssh/telnet/docker/(wsl). FTP, VNC, RDP and the mock are
   desktop-only — a connection that works locally silently cannot be run through a remote agent.
2. **Tunnelling is hard-coded to SSH (PARITY-001, high).** `tunnel_manager.rs` rejects any
   `type_id != "ssh"`. No other TCP-capable backend can host a forward, and the restriction is a
   string check rather than a capability.
3. **Monitoring is SSH-only despite a generic `monitoring` capability flag (PARITY-002, high).**
   Every non-SSH backend hard-returns `monitoring(): None`, including local shell, Docker and WSL
   where the data is readily available.
4. **Reconnect/resilience is modelled three different, differently-named ways (PARITY-008, high),**
   with opposite defaults (SSH `resilientReconnect` off; graphical `autoReconnect` on).
5. **File-transfer richness is uneven (PARITY-004, medium):** FTP has a full pause/resume/retry
   queue; SFTP has cancel-only single-phase copy; Docker/local have no progress transfer at all
   (whole-file read/write only).
6. **Auth is not a shared concept (PARITY-010, medium):** SSH uses an ad-hoc `authMethod` string,
   FTP an `anonymous` bool, graphical backends a typed `AuthKind` enum — and no backend supports
   client certificates or 2FA/keyboard-interactive.

## Release-blocking

- **PARITY-009 (mock-remote-desktop in default build features)** is the clearest release gate: a
  dev/test-only protocol-less backend ships registered in the default desktop build and is reachable
  by any user who toggles experimental features. It should be excluded from release builds.
- **PARITY-003 (agent feature subset)** is release-relevant because it is a silent capability cliff:
  the same saved connection behaves differently depending on whether it runs locally or via an
  agent, with no UI signal.

All other findings are correctness/consistency debt that should be triaged but are not, on their
own, launch blockers.

## Finding index

| ID | Sev | Title |
|---|---|---|
| PARITY-001 | high | Port-forwarding / tunnels are hard-coded SSH-only |
| PARITY-002 | high | System monitoring is SSH-only despite a generic capability flag |
| PARITY-003 | high | Agent registry omits FTP/VNC/RDP/mock — agent connections are a subset of desktop |
| PARITY-004 | medium | File-transfer progress/pause/resume is uneven across SFTP / FTP / Docker |
| PARITY-005 | medium | `FileBrowser` trait has no permission-change (chmod) or copy op |
| PARITY-006 | medium | Connect-timeout config field named/absent inconsistently across backends |
| PARITY-007 | medium | Mid-connect cancellation implemented only by SSH |
| PARITY-008 | high | Reconnect/resilience modelled inconsistently, with opposite defaults |
| PARITY-009 | medium | `mock-remote-desktop` backend ships in default build features |
| PARITY-010 | medium | Authentication is modelled ad-hoc per backend; no cert / 2FA anywhere |
| PARITY-011 | info | Capabilities are self-reported, not enforced; two parallel backend traits |
| PARITY-012 | low | Keepalive / liveness detection differs per backend without a shared policy |
