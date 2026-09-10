---
id: PROD-056
title: Terminal output has no clickable hyperlink/URL detection
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/components/Terminal
evidence:
  - src/components/Terminal/Terminal.tsx:2
status: open
---

## What
URLs and file paths printed by programs are inert text. The terminal loads Fit/Unicode11/
Search/Serialize/WebGL addons but not `@xterm/addon-web-links`, and no link provider/handler
is registered.

## Why it matters
Ctrl/Cmd-clicking URLs (and file paths) in output is a baseline expectation set by iTerm2,
Windows Terminal, and VS Code. Its absence is immediately noticeable.

## Evidence
- `src/components/Terminal/Terminal.tsx:2-7` — addon list omits web-links.
- No `@xterm/addon-web-links` in package.json; no `registerLinkProvider`/`linkHandler` anywhere.

## Recommendation
Add `@xterm/addon-web-links` (and optionally a file-path link provider) with an OS-open handler.
