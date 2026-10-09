---
id: UI2-006
title: "Option-card selectors are hand-rolled three ways (settings radio-option, tunnel type-option, workflow-chip) instead of a shared primitive"
angle: ui-visual
severity: low
category: ui
is_workaround: false
subsystem: "src/components/Settings, TunnelEditor, WorkflowSidebar"
evidence:
  - src/components/Settings/UpdateSettings.tsx:170
  - src/components/Settings/SecuritySettings.tsx:364
  - src/components/Settings/SettingsPanel.css:256
  - src/components/Settings/SettingsPanel.css:277
  - src/components/TunnelEditor/TunnelEditor.tsx:527
  - src/components/TunnelEditor/TunnelEditor.css:76
  - src/components/TunnelEditor/TunnelEditor.css:95
  - src/components/WorkflowSidebar/WorkflowTriggersEditor.tsx:90
  - src/components/WorkflowSidebar/WorkflowEditorDialog.css:219
  - src/components/ui/RadioGroup.tsx:17
status: fixed
resolution: "#4352 — one shared ui/RadioGroup cards skin plus a toggle ui/Chip replace the three bespoke selector styles"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The 'pick one of N described options' card pattern is built separately in three places with diverging visuals and semantics. `settings-panel__radio-option` uses --radius-lg, a transparent fill and an accent 8% tint, with role=radio in UpdateSettings but aria-pressed in SecuritySettings. `tunnel-editor__type-option` uses --radius-md, a --bg-secondary fill, a color-mix onto bg-secondary, and no selected-state ARIA at all. workflow-chip toggles use a fully solid accent fill with --text-on-accent. Meanwhile ui/RadioGroup already supports rich card children via RadioGroupItem, and the concept's rule 1 says to extend a primitive rather than fork styles. The `__btn` guard does not catch these because they are not named `__btn`.

## Why it matters

The same interaction looks and announces differently from screen to screen, which is the drift the design system exists to prevent. Without a shared primitive, the next surface will add a fourth variant.

## Evidence

- src/components/Settings/UpdateSettings.tsx:170
- src/components/Settings/SecuritySettings.tsx:364
- src/components/Settings/SettingsPanel.css:256
- src/components/Settings/SettingsPanel.css:277
- src/components/TunnelEditor/TunnelEditor.tsx:527
- src/components/TunnelEditor/TunnelEditor.css:76
- src/components/TunnelEditor/TunnelEditor.css:95
- src/components/WorkflowSidebar/WorkflowTriggersEditor.tsx:90
- src/components/WorkflowSidebar/WorkflowEditorDialog.css:219
- src/components/ui/RadioGroup.tsx:17

## Recommendation

Add a card variant to ui/RadioGroup (RadioGroupItem with label and description, one selected style using --accent-color border and a tint), then migrate UpdateSettings, SecuritySettings and the TunnelEditor type selector onto it. For multi-select trigger chips, add a toggleable variant to ui/Chip (aria-pressed) and migrate WorkflowTriggersEditor. Delete the bespoke CSS blocks.

## Verification

Confirmed. UpdateSettings uses role=radio with aria-checked. SecuritySettings puts aria-pressed buttons inside role=radiogroup, which is an inconsistent and incorrect ARIA pattern. The TunnelEditor type buttons expose no selected state at all. ui/RadioGroup explicitly supports card children via RadioGroupItem. Workflow chips are multi-select toggles, so they belong to a different pattern and grouping them here is a stretch, but the core finding holds. It is a consistency and minor a11y issue, so low.
