---
id: MKT-001
title: RDP/VNC remote-desktop is a real feature but is completely absent from the README
angle: marketing / product positioning
severity: high
category: docs
is_workaround: false
subsystem: README.md / docs/concepts/implemented/remote-desktop-sessions.html
evidence:
  - README.md:75
  - CHANGELOG.md:20
  - docs/concepts/implemented/remote-desktop-sessions.html
  - audit/product-completeness/_summary.md
status: open
---

## What
termiHub ships a genuine graphical remote-desktop capability — **VNC and RDP** behind a
shared framebuffer layer (Rust-side decode, trust store, clipboard/audio) — confirmed by the
product-completeness audit as "real implementations, not stubs" and documented as an
*implemented* concept (`docs/concepts/implemented/remote-desktop-sessions.html`). The `0.1.0`
CHANGELOG headline even lists "remote-desktop (VNC/RDP) connections" as a launch feature.

Yet the README mentions **RDP/VNC/remote-desktop zero times**. A grep of the README for
`RDP`, `VNC`, and `remote desktop` returns 0 hits. The "Connection Types" feature list
(README.md:75–83) stops at local/SSH/serial/telnet/Docker/WSL/agent.

## Why it matters
This is the single biggest **undersell** in the shopfront. A cross-platform terminal *and*
remote-desktop hub in one app is a strong, rare differentiator (Termius/iTerm/PuTTY do not do
graphical RDP/VNC; MobaXplus/mRemoteNG territory). Burying a fully-built flagship makes the
product look like "yet another SSH client" when it is materially more. Prospective users who
want RDP/VNC will never learn termiHub has it — the capability is effectively
undiscoverable from the primary marketing surface.

Compounding it: the feature is also **experimental-gated** in the app (see PROD-067 /
connection-parity `#1705`), so even a user who installs won't see it unless they flip an
experimental toggle. Hidden in the app *and* hidden in the README = a finished flagship that
no user will find.

## Evidence
- `README.md:73-83` — Features → Connection Types: no RDP/VNC entry.
- `CHANGELOG.md:20` — 0.1.0 summary explicitly markets "remote-desktop (VNC/RDP) connections".
- `docs/concepts/implemented/remote-desktop-sessions.html` — full implemented concept.
- `audit/product-completeness/_summary.md` — "VNC/RDP are genuine implementations (not
  stubs)"; PROD-067 flags "experimental-gated + not in README".

## Recommendation
- Add **Remote Desktop (RDP / VNC)** to the README Connection Types list and to the tagline's
  breadth statement (see MKT-013).
- Lead with it in positioning — it is the clearest "why termiHub over Termius/iTerm" line.
- Resolve the experimental gate for launch, or if it must ship experimental, say so honestly
  in the feature entry ("experimental — enable under Settings → General") the same way the
  Workflow Automation section already does. Do not leave a shipped flagship both gated and
  undocumented.
- Include a screenshot of an RDP/VNC session (ties to MKT-003).
