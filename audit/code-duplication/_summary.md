# Code duplication & core-centralization audit

**Angle:** duplicated logic across `core` / `src-tauri` / `agent` (and within a crate) that should
live once in `core`; the frontend↔backend (TS↔Rust) drift surface. **30 findings.**

## Headline

`core` is genuinely doing most of the heavy lifting. The **hard, correctness-critical algorithms**
are single-sourced in `core` and reused by both the desktop and the agent: terminal backends + PTY
spawn, the `RingBuffer`, output coalescing/screen-clear/logging, tunnel forward engines (SOCKS5,
relay, bind), embedded-server serving + lifecycle, system-stats parsing + CPU math + HTTP monitor,
and every network-tool implementation + result type. Credentials are correctly desktop-only (the
agent has none). Recent migrations (#2104 file browser, #2154/#2192 services, #2592 http-monitor)
landed well.

The duplication that remains is concentrated in **two seams**:

1. **The desktop↔agent wire protocol has no shared definition.** `src-tauri` depends on
   `termihub-core` but **not** on the agent crate, so all ~70 RPC param/result DTOs (defined only in
   `agent/src/protocol/methods.rs`) and all ~40 method-name strings are re-expressed on the desktop
   as hand-built `serde_json::json!` and `Value` indexing. The compiler cannot see the relationship
   between the two sides. This is the root cause behind a cluster of findings (DUP-001, -002, -004,
   -008, -014, -019) and has **already produced at least one latent bug** (rename sends `from/to`,
   agent expects `old_path/new_path` — DUP-001).

2. **Per-crate orchestration around the shared core is copy-pasted.** The session state machine and
   output-forwarder are hand-rolled twice (desktop + agent), the "control a service on a remote
   agent" plumbing is copy-pasted three times in `src-tauri`, and the network tools are wrapped in
   three parallel adapter layers (the agent exposing them under two RPC families).

## Centralization scorecard

| Capability | Where it lives today | Verdict |
|---|---|---|
| **Terminal backends + PTY spawn** | `core::backends`, `core::session` (builders); agent daemon & desktop both consume | **Centralized** ✔ |
| **Ring buffer / output coalescing / logging** | `core::buffer`, `core::output` | **Centralized** ✔ (constants redeclared — DUP-006) |
| **Protocol: error codes + notification type** | `core::protocol::{errors,messages}`, agent re-exports | **Centralized** ✔ (test module copied+drifted — DUP-003) |
| **Protocol: RPC param/result DTOs** | `agent::protocol::methods` only; desktop hand-builds JSON | **Not centralized** — DUP-001 |
| **Protocol: method-name strings** | string literals on both sides | **Not centralized** — DUP-002 |
| **Protocol: transport framing (NDJSON)** | 3 impls (core thin / agent robust / desktop hand-rolled) | **Duplicated** — DUP-009 |
| **Session lifecycle / registry** | desktop `SessionManager` + agent `SessionManager`, no core home | **Duplicated (parallel)** — DUP-010, -011, -012 |
| **Connection / folder definitions** | agent `Connection`, desktop `SavedConnection`, TS | **Duplicated (parallel)** — DUP-008, -014 |
| **File browsing / SFTP / path utils** | `core::files` + `core::backends::ssh` | **Centralized** ✔ |
| **Local file mutation ops** | sync in `src-tauri`, async in `core` — diverged | **Duplicated** — DUP-023, -024 |
| **File transfer (byte-moving + queue/state/retry)** | FTP primitive in core; SFTP loop + all domain logic in `src-tauri` | **Partially centralized** — DUP-025, -026 |
| **Tunnel forward engines** | `core::tunnel` (desktop + agent re-export) | **Centralized** ✔ |
| **Tunnel orchestration (enum, start path, wire type)** | duplicated in desktop + agent | **Duplicated** — DUP-017, -018, -019 |
| **System monitoring (parse/CPU/status/HTTP)** | `core::monitoring`, both consume | **Centralized** ✔ (wire struct copied — DUP-015, -016) |
| **Network tools (impl + result types)** | `core::network` | **Centralized** ✔ |
| **Network tool adapters (wrappers/defaults/DNS parse)** | 3 parallel layers | **Duplicated** — DUP-027, -028, -029 |
| **Embedded servers (serving + lifecycle)** | `core::embedded_servers` + `core::service` | **Centralized** ✔ |
| **Agent-hosted-service control layer** | copy-pasted 3× in `src-tauri`; drain loop 4× | **Duplicated** — DUP-020, -021, -022 |
| **Credentials** | `src-tauri::credential` only | **Correctly desktop-only** ✔ |
| **Reconnect/backoff** | `core::reconnect_backoff` exists but 3+ loops re-roll it | **Underused** — DUP-007 |
| **Rust↔TS DTOs** | hand-mirrored everywhere, no codegen | **Duplicated (cross-language)** — DUP-030 |

## Top consolidation opportunities (ranked by payoff)

1. **Create a shared protocol home (`core::protocol::methods` or a `termihub-protocol` crate)** for
   the RPC DTO structs + method-name constants + transport constants, imported by both the agent and
   the desktop. Kills DUP-001, -002, -004, -019 and de-risks -008/-014; makes the whole wire a
   compiler-checked contract. **Highest payoff — this is the intended app↔agent shared home that
   does not exist yet.**
2. **A generic `core::session::SessionRegistry` + adopt the core `OutputSink`** on the desktop
   (DUP-010, -011, -012). Removes two hand-rolled copies of the reconnect-critical
   "backend-died ⇒ settle/exit" path.
3. **Extract `AgentHostedServices` in `src-tauri`** (DUP-020, -021) — one poller/event-bridge/handle-
   map helper instead of three copies of subtle concurrency code.
4. **Converge network tools on the existing `core::tool::ToolRegistry`** (DUP-027 → -028, -029) and
   drop the agent's second `network.*` surface.
5. **Adopt Rust→TS codegen** (`ts-rs`/`typeshare`) for IPC DTOs (DUP-030) — the frontend↔backend
   analog of #1.
6. **Route reconnect/tunnel/transfer loops through `core::reconnect_backoff`** (DUP-007) and unify
   the streaming-copy primitive (DUP-025).

## Worst app↔agent divergence risks

- **DUP-001 — no shared RPC DTOs (HIGH).** The two sides of a safety-relevant transport are defined
  twice with no compiler linkage; already produced a latent rename bug; only covered by the CI-dark
  integration lane.
- **DUP-010 / DUP-011 — dual session state machine + output-forwarder (HIGH).** The
  "natural-exit ⇒ Exited" and attach/detach reconnect logic is reimplemented twice and has diverged.
- **DUP-020 — agent-hosted-service control layer copied 3× (HIGH).** Poller-leak / broadcast-lag bug
  classes must be fixed in three places.
- **DUP-004 / DUP-009 — transport constant + framing coupling (MED).** The 64 KiB forward chunk and
  1 MiB line cap are matched by comment, not by a shared constant; the desktop's hand-rolled framing
  omits the size cap the agent enforces.

## Note

Findings sourced from direct reading plus six focused sub-investigations (tunnel, monitoring,
network, embedded servers, files/transfer, session/backends). `is_workaround: true` on DUP-012
(dead `ProcessSpawner` seam) and DUP-019 (hand-poked JSON tag). Severities: 4 high, 15 medium, 11
low.
