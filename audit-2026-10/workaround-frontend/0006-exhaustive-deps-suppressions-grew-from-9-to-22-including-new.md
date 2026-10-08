---
id: WA-FE2-006
title: "exhaustive-deps suppressions grew from 9 to 22, including new JSON.stringify dependency-key hacks"
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: "components (editors/dialogs)"
evidence:
  - src/components/Settings/CustomRuleEditor.tsx:180
  - src/components/Settings/CustomRuleEditor.tsx:181
  - src/components/Settings/CustomRuleEditor.tsx:191
  - src/components/Settings/CustomRuleEditor.tsx:192
  - src/components/TunnelEditor/TunnelEditor.tsx:281
  - src/components/TunnelEditor/TunnelEditor.tsx:282
  - src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:153
  - src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:154
  - src/components/ThemeEditor/ThemeEditor.tsx:136
  - src/components/ThemeEditor/ThemeEditor.tsx:137
  - src/components/TransferView/TransferPane.tsx:141
  - src/components/TransferView/TransferPane.tsx:142
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: WA-FE-011
---

## What

WA-FE-011's fix (#3017) memoized the `.join(',')` dependency-key hack and justified the mount-once suppressions. The production `eslint-disable-next-line react-hooks/exhaustive-deps` count is now 22, up from 9. Blame shows that on 2026-09-18 four new `[JSON.stringify(draft|form|meta)]` dependency-key hacks were added (CustomRuleEditor ×2, TunnelEditor, EmbeddedServerDialog, ThemeEditor), which is the pattern the fix said to remove. TransferPane.tsx:141 (2026-09-26) suppresses with no justification at all.

## Why it matters

A serialized dependency key re-stringifies the whole draft on every render, and the suppression hides any other dependency the memo later starts reading, which is how stale-closure bugs get in. For example, CustomRuleEditor:191 already mixes a stringify key with a real `config` dependency. Without a guard, the count keeps climbing.

## Evidence

- `src/components/Settings/CustomRuleEditor.tsx:180`
- `src/components/Settings/CustomRuleEditor.tsx:181`
- `src/components/Settings/CustomRuleEditor.tsx:191`
- `src/components/Settings/CustomRuleEditor.tsx:192`
- `src/components/TunnelEditor/TunnelEditor.tsx:281`
- `src/components/TunnelEditor/TunnelEditor.tsx:282`
- `src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:153`
- `src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:154`
- `src/components/ThemeEditor/ThemeEditor.tsx:136`
- `src/components/ThemeEditor/ThemeEditor.tsx:137`
- `src/components/TransferView/TransferPane.tsx:141`
- `src/components/TransferView/TransferPane.tsx:142`

## Recommendation

Derive the values with react-hook-form `useWatch` or a `useMemo`'d draft object keyed on the actual watched fields, then depend on the real values. Alternatively, add a shared `useStableValue(value, isEqual)` hook that returns a referentially stable value, and delete the suppressions. In TransferPane, either list `onSelectedChange` (after stabilizing it with useCallback in the parent) or add the one-line justification the WA-FE-011 fix required.

## Verification

Confirmed in substance. There are 23 production `eslint-disable-next-line react-hooks/exhaustive-deps` sites (the finding says 22). `[JSON.stringify(draft|form|meta)]` keys exist in CustomRuleEditor.tsx:181/192, TunnelEditor.tsx:282, EmbeddedServerDialog.tsx:154 and ThemeEditor.tsx:137. TransferPane.tsx:141 suppresses with no justification while omitting onSelectedChange. Mitigation: some sites do carry a justification comment (CustomRuleEditor), which WA-FE-011's fix accepted. This is code-hygiene drift, not a demonstrated bug.
