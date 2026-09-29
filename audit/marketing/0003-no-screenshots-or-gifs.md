---
id: MKT-003
title: README has no screenshots or GIFs for a visually-driven desktop app
angle: marketing / product positioning
severity: high
category: docs
is_workaround: false
subsystem: README.md / public/
evidence:
  - README.md:1
  - README.md:129
  - docs/concepts/_assets/.preview/
status: open
---

## What
The README contains **no product screenshots and no GIFs**. The only image is the 128px logo
SVG at the top (README.md:1-3). The "Interface Overview" (README.md:129-146) conveys the UI
with an **ASCII-art box diagram** instead of a real screenshot. For a VS-Code-style desktop
GUI whose entire value is visual (split panes, drag-and-drop tabs, themes, remote desktop,
network-tool charts), showing zero pixels of the actual app is a serious shopfront gap.

Ironically, the repo already contains ~17 rendered preview PNGs under
`docs/concepts/_assets/.preview/` (plugin manager, SFTP transfer queue, macro editor, jump-host
editor, etc.) — mockups, but demonstrably renderable assets — and the codebase has a
screenshot tool (`scripts/internal/screenshot-mockup.sh`). None are used in the README.

## Why it matters
Screenshots are the highest-converting element of a developer-tool README. A prospect deciding
between termiHub and iTerm/Termius/Tabby in the first 30 seconds forms a "does this look
polished / do I want this" judgment almost entirely from imagery. A README with an ASCII
diagram and no real UI reads as unfinished or hobbyist regardless of how mature the code is —
which, per the completeness audit, badly undersells this product. It also fails the harness's
own "first-30-seconds" test.

## Evidence
- `README.md:1-3` — only image is the logo.
- `README.md:129-146` — interface shown as ASCII box art, not a screenshot.
- `docs/concepts/_assets/.preview/*.png` — existing renderable preview assets, unused in README.

## Recommendation
- Add a **hero screenshot** of the real app (split terminals + connection sidebar + a theme)
  directly under the tagline.
- Add a short **GIF** of the signature interaction (drag-and-drop tab into a split, or
  connect-to-server) — this is the single best conversion asset.
- Add 3–5 feature screenshots for the undersold flagships (RDP/VNC session, network-tools
  charts, plugin manager, tunnels sidebar).
- Replace or supplement the ASCII interface diagram with a captioned annotated screenshot.
- Commit real captured PNGs to a `docs/screenshots/` (or `assets/`) dir; do not rely on the
  concept mockups as substitutes for real app captures.
