---
id: UI-011
title: var(--token, #fallback) fallbacks carry inconsistent stale values for the same token
angle: ui-visual
severity: low
category: ui
is_workaround: false
subsystem: src/components
evidence:
  - src/components/Settings/SettingsPanel.css:446
  - src/components/Settings/SettingsPanel.css:500
  - src/components/FileEditor/FileEditor.css:92
  - src/components/UpdateNotification/UpdateNotification.css:16
  - src/components/Terminal/TerminalViewModeBanner.css:11
status: open
---

## What
The token-discipline guard explicitly exempts the `var(--token, #hex)` fallback form as an
"acceptable defensive default." But across the codebase the **same token is given different
fallback values**, so the fallbacks have quietly drifted:

- `--color-error` fallbacks seen: `#ef6b5a` (SettingsPanel:446, PortableModeSettings),
  `#e05555` (SettingsPanel:500), `#e05252` (FileEditor:92,102,103; FileBrowserTab),
  `#f44336` (UpdateNotification:16,43; StatusBar:383).
- `--color-warning` fallbacks seen: `#d4a843` (SettingsPanel, UpdateSettings) vs `#e8a838`
  (TerminalViewModeBanner, TerminalDisconnectOverlay).
- `--color-success` fallbacks: `#7dcf88` vs `#e05252`-era values.
- `--terminal-bg` fallback `#1e1e1e` (matches dark.ts, but that's the *other* palette from
  variables.css — see UI-001).

## Why it matters
- These are **dead today** (the undefined-token guard, #2052/#2063, ensures the tokens are
  always defined, so the fallback never renders) — hence low severity — but they are a
  maintenance trap: four different "brand red"s and two "warning amber"s sit in the source as
  if authoritative. Anyone copying a line as a template propagates a wrong color, and if the
  undefined-token guard is ever relaxed, mismatched colors render.
- They also encode the UI-001 palette confusion (`#f44336` Material red vs `#ef6b5a`
  variables.css red vs `#f48771` dark.ts red — three different reds all standing in for
  `--color-error`).

## Evidence
`grep -rn "var(--color-error," src/components` and `var(--color-warning,` show the divergent
hex fallbacks listed above.

## Recommendation
Either normalize every fallback to the token's canonical value (a single red, single amber,
etc., taken from the chosen source-of-truth palette per UI-001) or — cleaner — **drop the hex
fallbacks entirely**, since the undefined-token guard already guarantees the tokens resolve.
That removes ~40 stale hex literals and the drift vector in one pass.
