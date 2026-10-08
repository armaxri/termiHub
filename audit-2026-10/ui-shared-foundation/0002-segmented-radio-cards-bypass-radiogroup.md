---
id: UISF2-002
title: "Segmented 'radio card' choices hand-roll radio semantics (wrong or missing ARIA, no arrow-key roving) instead of ui/RadioGroup"
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: "src/components (TunnelEditor, ConnectionEditor, Settings)"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - src/components/TunnelEditor/TunnelEditor.tsx:523
  - src/components/TunnelEditor/TunnelEditor.tsx:524
  - src/components/TunnelEditor/TunnelEditor.tsx:526
  - src/components/ConnectionEditor/JumpHostEntry.tsx:131
  - src/components/ConnectionEditor/JumpHostEntry.tsx:134
  - src/components/Settings/UpdateSettings.tsx:169
  - src/components/Settings/UpdateSettings.tsx:171
  - src/components/Settings/SecuritySettings.tsx:360
  - src/components/Settings/SecuritySettings.tsx:367
  - src/components/Sidebar/AgentSetupDialog.tsx:437
  - src/components/ui/RadioGroup.tsx:17
---

## What

ui/RadioGroup supports rich card options through `children` + `RadioGroupItem`, and AgentSetupDialog.tsx:437 uses it that way. Four other single-choice selectors re-implement the pattern with raw `<button>`s, each with different semantics. (1) The TunnelEditor tunnel-type selector (Local/Remote/Dynamic) has no role, no aria-pressed or aria-checked, and no `type="button"`; selection is shown only by a CSS `--active` class, and the `<label>Tunnel Type</label>` is orphaned. (2) JumpHostEntry and (3) UpdateSettings use `role="radio"` buttons with no arrow-key handling, and every option is a separate tab stop; UpdateSettings' radiogroup also has no accessible name. (4) SecuritySettings puts `aria-pressed` toggle buttons inside `role="radiogroup"`, which is invalid ARIA because a radiogroup must own radios.

## Why it matters

Assistive technology does not announce which tunnel type is selected. Where role=radio is claimed, the ARIA radio contract is broken: arrow keys don't move selection and tab order isn't roving. The credential-storage-mode chooser exposes a radiogroup with no radios. The shared primitive that fixes all of this exists and already has a card-style reference use (AgentSetupDialog). UISF-009 covered raw `<input type=radio>`; this segmented-button variant slipped past it.

## Evidence

- `src/components/TunnelEditor/TunnelEditor.tsx:523`
- `src/components/TunnelEditor/TunnelEditor.tsx:524`
- `src/components/TunnelEditor/TunnelEditor.tsx:526`
- `src/components/ConnectionEditor/JumpHostEntry.tsx:131`
- `src/components/ConnectionEditor/JumpHostEntry.tsx:134`
- `src/components/Settings/UpdateSettings.tsx:169`
- `src/components/Settings/UpdateSettings.tsx:171`
- `src/components/Settings/SecuritySettings.tsx:360`
- `src/components/Settings/SecuritySettings.tsx:367`
- `src/components/Sidebar/AgentSetupDialog.tsx:437`
- `src/components/ui/RadioGroup.tsx:17`

## Recommendation

Migrate all four to `<RadioGroup value onValueChange aria-labelledby>` with `RadioGroupItem` composed inside the existing card markup, following AgentSetupDialog. Keep the visual `--active` styling keyed off `data-state=checked`. Point the TunnelEditor group label at the group through `aria-labelledby` (or use ui/Field). Optionally add a `variant="cards"` to RadioGroup so the `settings-panel__radio-option` / `tunnel-editor__type-option` / `jump-host__source-opt` skins collapse into one.

## Verification

Confirmed. TunnelEditor's type buttons have no role, aria-pressed/aria-checked or type=button, and the 'Tunnel Type' label is orphaned. JumpHostEntry and UpdateSettings use role=radio with no arrow-key handling, and UpdateSettings' radiogroup has no name. SecuritySettings puts aria-pressed buttons inside role=radiogroup. AgentSetupDialog already uses ui/RadioGroup for this pattern.
