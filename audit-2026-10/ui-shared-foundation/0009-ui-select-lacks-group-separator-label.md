---
id: UISF2-009
title: "ui/Select lacks group/separator/label exports, so callers import Radix directly and reuse private ui-select__ classes"
angle: ui-shared-foundation
severity: low
category: arch
is_workaround: true
subsystem: "src/components/ui"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - src/components/ConnectionEditor/ConnectionEditor.tsx:4
  - src/components/ConnectionEditor/ConnectionEditor.tsx:1547
  - src/components/Settings/AppearanceSettings.tsx:2
  - src/components/Settings/AppearanceSettings.tsx:212
  - src/components/ui/Select.tsx:23
---

## What

ui/Select documents a `children` mode for grouped options but exports only `SelectItem`. ConnectionEditor (connection-type 'Plugins' group) and AppearanceSettings (theme 'Plugins' group) therefore `import * as RadixSelect from "@radix-ui/react-select"` and hand-write `RadixSelect.Group/Separator/Label` with the primitive's internal class names `ui-select__separator` / `ui-select__group-label`.

## Why it matters

This is a workaround for a hole in the primitive. The internal class names are now a de-facto public API, and any restyle or Radix upgrade of ui/Select must update these two features by hand. The same grouped-select markup is duplicated in both places.

## Evidence

- `src/components/ConnectionEditor/ConnectionEditor.tsx:4`
- `src/components/ConnectionEditor/ConnectionEditor.tsx:1547`
- `src/components/Settings/AppearanceSettings.tsx:2`
- `src/components/Settings/AppearanceSettings.tsx:212`
- `src/components/ui/Select.tsx:23`

## Recommendation

Export `SelectGroup`, `SelectSeparator` and `SelectLabel` (thin forwardRef skins applying the ui-select classes) from ui/Select and ui/index.ts. Migrate both call sites and drop their direct Radix imports.

## Verification

Confirmed. ui/Select.tsx exports only Select and SelectItem. ConnectionEditor.tsx:1547-1549 and AppearanceSettings.tsx:212-216 use RadixSelect.Group/Separator/Label directly with the internal `ui-select__separator` and `ui-select__group-label` classes.
