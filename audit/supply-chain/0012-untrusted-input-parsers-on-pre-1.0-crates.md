---
id: SUP-012
title: Most untrusted-remote-input parsers are pre-1.0 crates — the deps most needing to be current
angle: supply-chain
severity: low
category: supply-chain
is_workaround: false
subsystem: core/backends
evidence:
  - core/Cargo.toml:36
  - core/Cargo.toml:66
  - core/Cargo.toml:104
  - agent/Cargo.toml:41
  - core/Cargo.toml:26
status: open
---

## What

The crates that parse **untrusted remote input** — the ones a supply-chain audit
should watch most closely because a parsing bug in them is directly
attacker-reachable — are predominantly pre-1.0 (`0.x`) versions:

| Path / data | Crate | Version |
| --- | --- | --- |
| SSH transport | `russh` / `russh-sftp` | 0.61 / 2.3 |
| VNC/RFB framebuffer | `vnc-rs` (vendored) + `zune-jpeg` | 0.5.3 / 0.4 |
| RDP (sidecar) | `ironrdp` | 0.17 |
| FTP/FTPS | `suppaftp` | 11 (past 1.0 — the exception) |
| Terminal escape parsing | `vte` | 0.13 |
| Embedded FTP server (accepts remote clients) | `libunftp` / `unftp-sbe-fs` | 0.20 / 0.2 |
| Embedded HTTP server | `axum` / `tower-http` | 0.7 / 0.5 |
| Agent JSON-RPC | `jsonrpsee` | 0.24 |
| Network tools (parse network responses) | `hickory-resolver` / `surge-ping` / `pnet_packet` | 0.26 / 0.8 / 0.35 |

## Why it matters

This is an observation, not a defect (hence low/info) — pre-1.0 is the norm in the
Rust protocol-crate ecosystem and does not imply the crate is unsafe. But it
frames *where* the yank/advisory gates matter most and *which* deps most reward
staying current: a soundness fix in `vte`, `russh`, `ironrdp`, or `libunftp`
lands on the exact code that touches hostile bytes. Two of these (`vnc-rs`,
`ironrdp-rdpsnd`) are *frozen forks* with no update path (SUP-005), and the
`ironrdp` graph is *entirely ungated* (SUP-001) — so precisely the highest-value
parsers to keep current are the ones the tooling covers least. The FTP client was
already bitten twice by advisories on this class (RUSTSEC-2025-0052 async-std,
RUSTSEC-2026-0271 CRLF injection — see `core/Cargo.toml:60-65`), confirming the
pattern is not theoretical.

## Evidence

- `core/Cargo.toml:36-37` (russh/russh-sftp via workspace), `:66-70` (suppaftp),
  `:104` (vte), `:125-132` (axum/tower-http/libunftp/unftp-sbe-fs), `:26-28`
  (hickory-resolver/surge-ping), `:91-96` (vnc-rs/zune-jpeg).
- `agent/Cargo.toml:41` (jsonrpsee).
- `rdp-sidecar/Cargo.toml:24` (ironrdp).
- `core/Cargo.toml:60-65` — documented prior FTP advisories, evidence this class
  gets hit.

## Recommendation

Maintain an explicit "untrusted-input parser" watchlist (the table above) and
prioritize it in the update chore and in release-prep review: these crates should
be on their latest compatible release at each release, and any advisory touching
them treated as higher priority than a general dep bump. Combine with SUP-001
(bring the ironrdp graph under the gate) and SUP-005 (unfreeze the vnc-rs /
ironrdp-rdpsnd forks) so the watchlist is actually enforceable rather than
manual. No version bump is required today — this is about ensuring the process
watches the right subset.
