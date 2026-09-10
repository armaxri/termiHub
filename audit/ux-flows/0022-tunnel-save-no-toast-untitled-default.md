---
id: UX-022
title: Saving a tunnel gives no success toast; an unnamed tunnel is silently saved as "Untitled Tunnel"
angle: ux-flows
severity: low
category: ux
is_workaround: false
subsystem: src/components/TunnelEditor
evidence:
  - src/components/TunnelEditor/TunnelEditor.tsx:167
  - src/components/TunnelEditor/TunnelEditor.tsx:157
  - src/store/slices/tunnelSlice.ts:173
status: open
---

## What
A successful plain **Save** of a tunnel shows no toast: `saveTunnel` (`tunnelSlice.ts:173-183`)
emits neither success nor error, and `handleSave` (`TunnelEditor.tsx:167-191`) just closes the tab —
the only "feedback" is the tab disappearing. This is inconsistent with Duplicate/Delete/Start, which
all toast (e.g. `TunnelSidebar.tsx:60`). Separately, an unnamed tunnel is silently saved as
`"Untitled Tunnel"` (`TunnelEditor.tsx:157`) with no prompt, so a user who forgets a name gets an
"Untitled Tunnel" row and no indication one was auto-named.

## Why it matters
Save is the primary action of the editor and it is the one with no confirmation feedback — the user
is left to infer success from the tab closing. The silent "Untitled Tunnel" compounds this: a
forgotten name produces an indistinct row with no signal.

## Evidence
- `TunnelEditor.tsx:167-191` — handleSave closes the tab, no success toast.
- `tunnelSlice.ts:173-183` — saveTunnel emits no success toast.
- `TunnelEditor.tsx:157` — unnamed → "Untitled Tunnel", no prompt.

## Recommendation
Emit a `toast.success("Saved tunnel …")` on successful save, matching Duplicate/Delete/Start. Either
require a name (disable Save when blank, as several editors do) or clearly indicate the auto-assigned
name.
