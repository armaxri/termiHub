---
id: UI-008
title: Terminal-covering overlays use four different backdrop treatments
angle: ui-visual
severity: medium
category: ui
is_workaround: false
subsystem: src/components/Terminal, src/components/RemoteDesktop
evidence:
  - src/components/Terminal/TerminalConnectionOverlay.css:5
  - src/components/Terminal/TerminalDisconnectOverlay.css:9
  - src/components/Terminal/AgentErrorTab.css:5
  - src/components/RemoteDesktop/RemoteDesktopTab.css:114
status: open
---

## What
Four overlays cover the same conceptual surface — "a status/action panel drawn on top of a
terminal or remote-desktop view" — and each uses a **different backdrop**:

- `TerminalConnectionOverlay.css:5` — `background-color: var(--terminal-bg)` (fully opaque).
- `AgentErrorTab.css:5` — `background-color: var(--terminal-bg)` (fully opaque).
- `TerminalDisconnectOverlay.css:9-10` — `color-mix(in srgb, var(--terminal-bg) 88%,
  transparent)` **+ `backdrop-filter: blur(2px)`** (translucent, blurred).
- `RemoteDesktopTab.css:114` — `background: var(--overlay-bg)` (the dark *modal* scrim,
  `rgba(6,7,10,0.66)` + a separate blur elsewhere).

So the "connecting" overlay is opaque, the "disconnected" overlay is translucent+blurred,
the agent-error overlay is opaque, and the remote-desktop overlay uses the modal scrim.

## Why it matters
- The transitions between connection states (connecting → connected → disconnected) show the
  terminal appearing/disappearing behind visibly different treatments, which reads as
  unfinished rather than intentional.
- The `blur(2px)` in the disconnect overlay is a **raw magic value** — the design system has
  `--overlay-blur: blur(8px) saturate(120%)`, so this overlay's blur is both inconsistent and
  off-token.
- This compounds the shared-foundation finding UISF-008 (the same overlay skeleton is
  reimplemented 4× with 4 BEM prefixes) — the visual treatment diverges alongside the markup.

## Evidence
See the four files/lines above; `grep -rn "backdrop-filter\|background.*terminal-bg\|overlay-bg"`
across the terminal/remote-desktop overlays.

## Recommendation
Decide one backdrop language for terminal-covering overlays (recommend: translucent
`color-mix(var(--terminal-bg) 88%, transparent)` + `var(--overlay-blur)`, so the terminal
stays faintly visible under a "connecting/disconnected" state) and apply it uniformly. Best
folded into a shared `ContentOverlay` primitive (UISF-008) so the backdrop is defined once.
Replace the raw `blur(2px)` with `--overlay-blur` (or a lighter `--overlay-blur-sm` token if
a subtler blur is wanted).
