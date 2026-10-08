---
id: MKT2-005
title: "README has drifted again since MKT-002: newer features, shortcuts, file-browser modes and setup facts are missing or wrong"
angle: marketing / product positioning
severity: low
category: docs-accuracy
is_workaround: false
subsystem: "README.md"
evidence:
  - "README.md:139"
  - "README.md:187-206"
  - "README.md:350-355"
  - "README.md:372-382"
  - "README.md:614"
  - "README.md:57-63"
  - "README.md:701"
  - "README.md:705-710"
  - "src/themes/solarized-dark.ts"
  - "src/components/ThemeEditor/ThemeEditor.tsx"
  - "src/services/keybindings.ts:39-47"
  - "src/services/keybindings.ts:115-142"
  - "src/services/keybindings.ts:92-98"
  - "src/components/ActivityBar/ActivityBar.tsx:69-77"
  - "core/src/backends/docker/mod.rs:982"
  - "core/src/backends/wsl.rs:1064"
  - "core/src/backends/ftp/mod.rs:532"
  - "node_modules/vitest/package.json (engines ^20||^22||>=24)"
  - ".github/workflows/release.yml:1203"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The README's coverage has slipped since the MKT-002 fix.

- Themes (README.md:139) lists only Dark/Light/System. Solarized Dark/Light, custom themes with a Theme Editor, theme import/export and plugin themes also ship.
- Not mentioned anywhere: the command palette (Cmd+P / Ctrl+Shift+P, keybindings.ts:39-47), Find in Terminal, OSC 133 prompt navigation and command status marks (keybindings.ts:115-142, documented only in docs/keyboard-shortcuts.md), and the Open Connections panel.
- The shortcuts table (README.md:372-382) omits these. Its line 'On macOS, Cmd can be used in place of Ctrl' is wrong: Next/Previous Tab stay Ctrl+Tab on macOS (keybindings.ts:92-98), and Cmd+Tab is the OS app switcher.
- Interface Overview (README.md:187-206) describes only Connections and File Browser. The activity bar also has Recent Sessions, Workspaces, Macros, Plugins and Log Viewer (ActivityBar.tsx:69-77).
- The File Browser table (README.md:350-355) omits Docker, WSL and FTP, which all browse files.
- The Documentation list (README.md:705-710) does not link docs/keyboard-shortcuts.md or docs/plugin-authoring.md.
- Smaller facts: Node 'v18+' (README.md:614) is wrong, since vitest 4 and jsdom require Node 20.19+. The linux-arm64 .rpm release asset is not mentioned (README.md:57-63). 'tests/docker provides 13 Docker containers' (README.md:701) is outdated: there are now 22 fixture directories.

## Why it matters

Each item is small, but together they make the shopfront undersell the product again (the MKT-002 pattern) and give contributors wrong setup facts. The shortcut error affects every macOS user who reads it.

## Evidence

- `README.md:139`
- `README.md:187-206`
- `README.md:350-355`
- `README.md:372-382`
- `README.md:614`
- `README.md:57-63`
- `README.md:701`
- `README.md:705-710`
- `src/themes/solarized-dark.ts`
- `src/components/ThemeEditor/ThemeEditor.tsx`
- `src/services/keybindings.ts:39-47`
- `src/services/keybindings.ts:115-142`
- `src/services/keybindings.ts:92-98`
- `src/components/ActivityBar/ActivityBar.tsx:69-77`
- `core/src/backends/docker/mod.rs:982`
- `core/src/backends/wsl.rs:1064`
- `core/src/backends/ftp/mod.rs:532`
- `node_modules/vitest/package.json (engines ^20||^22||>=24)`
- `.github/workflows/release.yml:1203`

## Recommendation

Make one README refresh pass. Add Solarized and custom themes, command palette, find in terminal, shell integration and prompt jumps, and Open Connections to Features. Replace the shortcut table with the most-used bindings, both platforms shown explicitly, and link docs/keyboard-shortcuts.md. Update the activity-bar description. Add Docker, WSL and FTP rows to the file-browser table. Link keyboard-shortcuts.md and plugin-authoring.md under Documentation. Change the prerequisite to Node 20.19+ (or 22, matching CI). Mention the arm64 .rpm. Drop the hard-coded container count. To slow the next drift, consider a release-check step that diffs activity-bar items, connection types and auth options against README headings.

## Verification

Spot-checked and confirmed. Themes line lists only Dark/Light/System, yet solarized-dark/light.ts and customThemes.ts exist. The 'Cmd in place of Ctrl' note is wrong for next-tab (macDefault is ctrl+Tab). The file-browser table lacks Docker/WSL/FTP. Node v18+ conflicts with vitest's engines ^20. tests/docker now has 24 entries, not 13. keyboard-shortcuts.md and plugin-authoring.md are not linked. The release workflow builds an arm64 rpm that README does not mention. The command palette appears only once, in the Workflows text.
