---
id: UISF2-003
title: "RHF+zod editors each copy-paste the same synchronous-validity block, and three of them never show their zod error messages"
angle: ui-shared-foundation
severity: medium
category: arch
is_workaround: false
subsystem: "src/components (editors)"
status: fixed
resolution: "#4346 — shared useZodEditorForm hook serves all 9 editors; hidden name/root/port/colour errors now render inline"
audit: "2026-10"
commit: "663465d52"
relation: previous-incomplete
previous_id: UISF-011
evidence:
  - src/components/Settings/CustomRuleEditor.tsx:157
  - src/components/Settings/CustomRuleEditor.tsx:168
  - src/components/ThemeEditor/ThemeEditor.tsx:125
  - src/components/MacroSidebar/MacroEditorDialog.tsx:151
  - src/components/MacroSidebar/MacroEditorDialog.tsx:51
  - src/components/MacroSidebar/MacroEditorDialog.tsx:357
  - src/components/WorkflowSidebar/WorkflowEditorDialog.tsx:78
  - src/components/WorkflowSidebar/WorkflowEditorDialog.tsx:162
  - src/components/WorkflowSidebar/WorkflowEditorDialog.tsx:264
  - src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:70
  - src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:142
  - src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:149
  - src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:269
  - src/components/TunnelEditor/TunnelEditor.tsx:270
  - src/components/TunnelEditor/TunnelEditor.tsx:282
  - src/components/Schedules/ScheduleEditorDialog.tsx:117
---

## What

The UISF-011 fix moved 8+ editors onto react-hook-form + zod but did not build the recommended shared `useEditorForm` wrapper. Each editor now re-implements the same scaffold: `useWatch({control})` → build a draft → `useMemo(() => schema.safeParse(draft), [JSON.stringify(draft)])` with an eslint-disable → loop over `issue.path.join('.')` into an errors map → `canSave`. There are 9 copies (CustomRuleEditor, ThemeEditor, MacroEditorDialog, WorkflowEditorDialog, EmbeddedServerDialog, TunnelEditor, ScheduleEditorDialog, ConnectionEditor, ConnectionSettingsForm). The copies have drifted on what they surface. CustomRuleEditor and ThemeEditor pass `nameError` into `<Field error>`. MacroEditorDialog maps only step errors, so its 'Name is required.' (line 51) is never shown (`<Field label="Name">` at :357 has no error). WorkflowEditorDialog keeps only `.success`, so its 'Name is required.' is dropped. EmbeddedServerDialog defines 'Name/Root directory/Port is required.' messages but renders no error anywhere.

## Why it matters

This is the 'Save silently disabled' failure class from #2467. In the Macro, Workflow and Embedded-server editors the Save button goes disabled and the editor already holds the reason, but the user never sees it. Each new editor copies the block again, and copies keep diverging on error display, memo keys and default merging. The UISF-011 fix ('RHF+zod in 8 editors') holds in letter, but the shared-hook half of its recommendation was never done, and the duplication grew with each migration.

## Evidence

- `src/components/Settings/CustomRuleEditor.tsx:157`
- `src/components/Settings/CustomRuleEditor.tsx:168`
- `src/components/ThemeEditor/ThemeEditor.tsx:125`
- `src/components/MacroSidebar/MacroEditorDialog.tsx:151`
- `src/components/MacroSidebar/MacroEditorDialog.tsx:51`
- `src/components/MacroSidebar/MacroEditorDialog.tsx:357`
- `src/components/WorkflowSidebar/WorkflowEditorDialog.tsx:78`
- `src/components/WorkflowSidebar/WorkflowEditorDialog.tsx:162`
- `src/components/WorkflowSidebar/WorkflowEditorDialog.tsx:264`
- `src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:70`
- `src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:142`
- `src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:149`
- `src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:269`
- `src/components/TunnelEditor/TunnelEditor.tsx:270`
- `src/components/TunnelEditor/TunnelEditor.tsx:282`
- `src/components/Schedules/ScheduleEditorDialog.tsx:117`

## Recommendation

Add `src/hooks/useZodEditorForm.ts` returning `{ form, draft, valid, errors: Record<path,string>, canSave }`. It would wrap useForm + zodResolver + useWatch + the memoised safeParse/issue-map once, with a stable deep-compare key instead of the per-site `JSON.stringify` + eslint-disable. Migrate the 9 editors. Wire `errors.name` (and the rootDirectory/port errors) into `<Field error>` in MacroEditorDialog, WorkflowEditorDialog and EmbeddedServerDialog. A test per editor that a blank name shows 'Name is required.' would lock this in.

## Verification

Confirmed. MacroEditorDialog maps only step errors from safeParse, so 'Name is required.' (line 51) never reaches the Name Field at :357. EmbeddedServerDialog:150 keeps only .success. WorkflowEditorDialog:164 likewise keeps only the result, and its Name Field has no error. The JSON.stringify memo plus eslint-disable block is copied across editors, and no shared useEditorForm/useZodEditorForm hook exists. This is the #2467 'Save silently disabled' class, but a blank name is fairly obvious to the user, so medium is the ceiling.
