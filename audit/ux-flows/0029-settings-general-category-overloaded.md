---
id: UX-029
title: Settings "General" category is overloaded across unrelated domains
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/Settings
evidence:
  - src/components/Settings/settingsRegistry.ts:26
  - src/components/Settings/settingsRegistry.ts:491
status: open
---

## What
The "General" settings category (`settingsRegistry.ts:26-37` + entries) crams together unrelated
domains: SSH auth defaults (`defaultUser`, `defaultSshKeyPath` — `:40-53`), local shell default
(`:54-60`), **serial port scan prefixes** (`:342-363`), four confirm/warn dialogs
(`confirmCloseTabOnShortcut`, `confirmCloseLiveSession`, `confirmCloseAttachedTab`,
`warnLargePortScan`, `warnLargePingSweep` — `:364-464`), the experimental-features flag (`:465-472`),
**session restore + history** (`:491-534`), and **X server** provisioning (`:535-548`).

## Why it matters
A user hunting for X-server behavior, session history, or serial scanning won't predict any of them
live under "General" — SSH auth, serial hardware, network-scan safety, session persistence, and X11
have nothing to do with each other and there is no sub-grouping. Settings search (`filterSettings`,
`:594`) mitigates but doesn't fix the navigational IA. Poor findability on the settings surface.

## Evidence
- `settingsRegistry.ts:26-37` — 10 categories.
- `settingsRegistry.ts:342-548` — the grab-bag of unrelated entries under `general`.

## Recommendation
Split "General" into coherent categories (e.g. Connections/Defaults, Terminal, Serial, Sessions &
Restore, Safety Prompts, X Server) or add sub-group headers within it. Group by the domain the user
thinks in, not by leftover.
