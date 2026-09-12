---
id: MKT-004
title: No value proposition, differentiation, or competitive framing — the "why termiHub" is missing
angle: marketing / product positioning
severity: high
category: docs
is_workaround: false
subsystem: README.md
evidence:
  - README.md:7
  - README.md:19
status: open
---

## What
The README never answers **"why use termiHub instead of PuTTY / iTerm2 / Windows Terminal /
Termius / MobaXterm / Tabby?"** The shopfront copy is purely descriptive:

- Tagline: "A modern, cross-platform terminal hub for managing multiple connections." (README.md:7)
- Intro: "termiHub provides a VS Code-like interface for managing multiple terminal
  connections…" (README.md:19)

There is no positioning statement, no target-user definition ("who is this for"), no
differentiation, and no competitive comparison. The word "hub" — the product's whole category
thesis — is asserted but never explained or defended.

## Why it matters
Developer-tool adoption is a comparison decision. Every prospect already has a terminal; the
README must give them a reason to switch or add. termiHub actually has strong, articulable
differentiators the copy leaves on the table:

- **One app spanning terminals *and* graphical remote desktop** (SSH/serial/telnet/Docker/WSL
  *plus* RDP/VNC) — rare.
- **Remote agents** for persistent sessions on headless servers that survive disconnects.
- **Session auto-save & restore** across app restarts.
- **A real plugin system** with code-signing.
- **Built-in network diagnostics + embedded servers** (MobaXterm-class, cross-platform, free/MIT).

Stated plainly, that is a compelling "why." Left unstated, termiHub reads as an interchangeable
SSH client and competes on nothing.

## Evidence
- `README.md:7` — generic tagline.
- `README.md:19` — descriptive intro, no differentiation.
- No comparison table or "why" section anywhere in the README (confirmed by heading scan).

## Recommendation
Add, near the top (after the hero screenshot):
- A **one-paragraph value proposition**: what termiHub is, who it's for, and the single
  strongest reason to choose it.
- A short **"Why termiHub"** bullet list of 4–6 genuine differentiators (breadth incl. remote
  desktop, remote agents, session restore, plugins, network tools, cross-platform + MIT/free).
- A lightweight **comparison table** vs. the obvious alternatives on the axes that matter
  (multi-protocol, RDP/VNC, persistent remote sessions, plugins, cross-platform, price/license).
  Keep it honest and factual to avoid looking like FUD.
- A one-line **category definition** of "terminal hub" so the coined term lands.
