---
id: UISF-008
title: Terminal/RDP connection overlays duplicate one icon+heading+actions skeleton four times — no shared ContentOverlay
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: src/components/Terminal
evidence:
  - src/components/Terminal/TerminalReconnectPrompt.tsx:28
  - src/components/Terminal/TerminalDisconnectOverlay.tsx:92
  - src/components/Terminal/TerminalConnectionOverlay.tsx:225
  - src/components/RemoteDesktop/RemoteDesktopOverlay.tsx:33
status: open
---

## What

Four components render an in-content overlay (over live terminal/RDP content, so a portalled Modal
would be wrong — legitimately not `Modal`). But all four reimplement the same skeleton —
container → `__body` → icon/spinner → heading → subheading → `__actions` row of small Buttons — with
four different BEM prefixes, and each hand-rolls its own dismiss `<button>` (which Modal provides for
free via `ui-modal__close`).

- `Terminal/TerminalReconnectPrompt.tsx:28-56` — `terminal-reconnect-prompt__dialog`; doc comment calls it "a small dialog".
- `Terminal/TerminalDisconnectOverlay.tsx:92,198,267,307,368` — five variants, each `terminal-disconnect-overlay__body`; raw dismiss `<button>` at :205,:314,:371.
- `Terminal/TerminalConnectionOverlay.tsx:225,242,293,349,394` — five states, `terminal-connection-overlay__body`.
- `RemoteDesktop/RemoteDesktopOverlay.tsx:33,45,…` — connecting/reconnecting/failed states, `rd-overlay__body`.

## Why it matters

The connect/reconnect/disconnect overlay is the app's primary connection-state feedback surface, and
it exists in four independently-maintained copies (~10 state variants total). They already differ in
class prefix, icon sizing, and dismiss affordance, and will keep drifting. This is the single largest
copy-paste of a display skeleton in the frontend.

## Evidence

Same `__body` + icon/spinner + `__heading`/`__title` + `__subheading`/`__sub` + `__actions` structure
repeated across the four files (frontmatter). The `__actions` row is "a row of `size=sm` Buttons"
each time; the dismiss X is hand-rolled in the disconnect overlay instead of reused.

## Recommendation

Add a shared `ContentOverlay` primitive (icon/spinner slot, heading, subheading, actions slot,
optional dismiss) to `src/components/ui/`, styled once with tokens, honouring the shared Spinner
(UISF-001) and reduced-motion. Render all four overlays through it. Pair it with the `ModalFooter`
consolidation in UISF-010 so overlay and modal action rows share one action-row style.
