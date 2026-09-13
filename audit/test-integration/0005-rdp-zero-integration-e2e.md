---
id: TIN-005
title: RDP has zero integration/E2E coverage — the entire connection type is manual-only
angle: test-integration
severity: high
category: test-gap
is_workaround: false
subsystem: core/backends/rdp, RDP sidecar
evidence:
  - core/tests/
  - tests/system/tests/
  - tests/docker/
  - docs/testing.md:1105
status: open
---

## What

RDP — a first-class connection type with its own sidecar
(`termihub-rdp-helper`, `scripts/build-rdp-sidecar.sh`) — has **no** automated
integration or end-to-end coverage of any kind:

- No `core/tests` integration suite (no `rdp*.rs`; `ls core/tests` shows
  ssh/telnet/vnc/ftp/tunnel but no rdp).
- No `tests/docker` fixture (no RDP server container in
  `tests/docker/docker-compose.yml`).
- No Python bridge suite (`grep rdp tests/system/tests` → no real matches).

Per `docs/testing.md`, RDP is verified **entirely manually**: connect, device
redirection (RDPDR #1757), audio (rdpsnd #1764, "macOS/Windows only"), clipboard
file transfer (CLIPRDR #1765/#1778), delayed-render paste per-OS
(#1804/#1814/#1815) — all manual test items. The only automated RDP tests are
unit tests of the sidecar wiring.

## Why it matters

- RDP is a graphical protocol with a native sidecar process and per-OS
  redirection channels — the highest-integration-risk backend in the app — yet
  it has the **least** automated coverage. A regression in connect, sidecar
  lifecycle, or channel negotiation ships unless a human runs the manual matrix.
- Manual-only means release-gated on human effort and easy to skip under time
  pressure; it does not catch drift between releases.
- Orphaned-sidecar cleanup ("no orphan `termihub-rdp-helper`") is asserted only
  by a manual step, so a process-leak regression is invisible to CI.

## Evidence

- `core/tests/` — no RDP file. `tests/docker/docker-compose.yml` — no RDP
  service. `tests/system/tests/` — no RDP suite.
- `docs/testing.md:1105` (via audit of the doc) — "per-PR CI does not run
  integration/container tests"; RDP coverage is the manual `tests/manual/*`
  items only.

## Recommendation

- Stand up a headless RDP fixture (e.g. `xrdp` in a container) and add at least a
  **backend integration test** (connect → sidecar handshake → framebuffer
  decode → clean teardown, no orphan helper), mirroring what `core/tests/vnc.rs`
  already does for VNC over the `vnc` compose profile.
- Add a bridge-level smoke that opens an RDP tab and asserts the canvas mounts +
  the sidecar starts/stops, so at least the app-side lifecycle is automated even
  if pixel fidelity stays manual.
- Until then, mark the RDP manual matrix explicitly release-gating and track the
  automation gap as a release risk.
