---
id: UI2-002
title: "Monaco editor is themed by theme id === 'light', so Solarized Light and light custom/plugin themes get a dark editor"
angle: ui-visual
severity: medium
category: ui
is_workaround: false
subsystem: "src/utils/monacoCustomLanguages.ts, src/components/FileEditor"
evidence:
  - src/utils/monacoCustomLanguages.ts:46
  - src/utils/monacoCustomLanguages.ts:55
  - src/utils/monacoCustomLanguages.ts:56
  - src/components/FileEditor/FileEditor.tsx:301
  - src/components/FileEditor/FileEditor.tsx:435
  - src/components/FileEditor/FileEditor.tsx:441
  - src/themes/solarized-light.ts:7
  - src/themes/types.ts:89
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

getMonacoTheme(appThemeId) returns 'light-plus' only when the id is exactly 'light'; every other id gets 'dark-plus'. FileEditor passes getCurrentTheme().id. The built-in Solarized Light theme (id 'solarized-light', colorScheme 'light'), any custom theme based on light, and any light plugin theme all get the VS Code dark-plus editor inside an otherwise light app. Separately, since UI-001 moved the dark palette to #0f1117, dark-plus's #1e1e1e editor background is a visibly lighter grey block than the surrounding --bg-primary and the terminal panes next to it.

## Why it matters

The file editor is a core surface. A light theme with a dark editor is the most obvious theme-fidelity break left in the app, and the comment at FileEditor.tsx:298 wrongly claims all modes are handled. The tests only cover 'light', 'dark' and an unknown id.

## Evidence

- src/utils/monacoCustomLanguages.ts:46
- src/utils/monacoCustomLanguages.ts:55
- src/utils/monacoCustomLanguages.ts:56
- src/components/FileEditor/FileEditor.tsx:301
- src/components/FileEditor/FileEditor.tsx:435
- src/components/FileEditor/FileEditor.tsx:441
- src/themes/solarized-light.ts:7
- src/themes/types.ts:89

## Recommendation

Key the mapping on colorScheme rather than id: getMonacoTheme(theme: ThemeDefinition) => theme.colorScheme === 'light' ? MONACO_LIGHT_THEME : MONACO_DARK_THEME, and update both FileEditor call sites. Optionally, define a Monaco theme override after shikiToMonaco that sets editor.background to the active --bg-primary / --terminal-bg so the editor matches the app. Add tests for solarized-light and for a custom theme with colorScheme 'light'.

## Verification

Confirmed. getMonacoTheme (monacoCustomLanguages.ts:55) returns light-plus only for id === 'light', and FileEditor.tsx:301/435/441 plus monacoCustomLanguages.ts:195/240/330 all pass getCurrentTheme().id. solarized-light has id 'solarized-light' and colorScheme 'light', so it gets dark-plus. No defineTheme or editor.background override exists anywhere in src. The comment at FileEditor.tsx:298 does wrongly claim the theme is always 'dark or light'. The #1e1e1e vs --bg-primary #0f1117 mismatch also holds.
