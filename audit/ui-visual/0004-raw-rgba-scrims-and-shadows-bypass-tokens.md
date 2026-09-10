---
id: UI-004
title: Raw rgba() scrims, white overlays and box-shadows bypass the token layer
angle: ui-visual
severity: medium
category: ui
is_workaround: false
subsystem: src/components
evidence:
  - src/components/Sidebar/FileBrowser.css:16
  - src/components/SplitView/SplitView.css:48
  - src/components/ActivityBar/ActivityBar.css:53
  - src/components/UpdateNotification/UpdateNotification.css:9
  - src/components/Terminal/TerminalReconnectPrompt.css:22
status: open
---

## What
A set of overlays, hover fills and shadows are written as raw `rgba()` literals instead of
tokens. The token-discipline guard misses them because it only blocks the single exact
scrim `rgba(0,0,0,0.7)` and bare `#fff` — any other alpha or channel passes.

- **Dark scrims (should be `--overlay-bg`):**
  `FileBrowser.css:16` and `SplitView.css:48` — `background: rgba(0, 0, 0, 0.55)` drag/drop
  overlays. A dedicated `--overlay-bg` token exists precisely for this.
- **White hover overlays (dark-only):**
  `ActivityBar.css:53,57` — `rgba(255, 255, 255, 0.06/0.1)`. The activity bar stays dark in
  the light theme so these happen to survive, but they encode a dark-theme assumption in raw
  values rather than a token.
- **Raw drop-shadows (should be `--shadow-md` / `--shadow-overlay`):**
  `UpdateNotification.css:9` — `0 4px 16px rgba(0,0,0,0.3)`;
  `TerminalReconnectPrompt.css:22` — `0 8px 32px rgba(0,0,0,0.5)`. Both are floating
  surfaces that should use the shared shadow tokens for a consistent elevation language.
- **Status tints:** `FileBrowser.css:265` `rgba(244,71,71,0.08)` (should be
  `--color-error-bg`).

## Why it matters
- These are exactly the ad-hoc overlays the token layer was built to eliminate; they are
  invisible to the regression guard, so they represent silent drift and will keep
  reappearing.
- The two drag scrims (`0.55`) differ from the modal scrim (`--overlay-bg` = `0.66` + blur),
  so drag overlays and modal overlays don't feel like one system.
- The raw shadows use different blur/spread than `--shadow-md`/`--shadow-overlay`, giving
  floating surfaces inconsistent elevation.

## Evidence
`grep -rn "rgba(" src/components/**/*.css` — see list; `var(--token, rgba(...))` *fallback*
forms are fine, the standalone ones above are not.

## Recommendation
Replace each standalone rgba with the matching token (`--overlay-bg`, `--shadow-md`/
`--shadow-overlay`, `--color-error-bg`, `--bg-hover`). For the activity-bar white overlays,
add a `--bg-hover-on-dark` token (or reuse the activity-bar tokens) so the dark assumption is
explicit. Tighten `tokenDiscipline.test.ts` to flag any standalone `rgba(`/`box-shadow:` with
raw offsets in `src/components/**`.
