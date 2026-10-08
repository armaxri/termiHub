---
id: UISF2-010
title: "Controls outside ui/Field and ui/Textarea are left without accessible names (AgentSetupDialog install path, RD clipboard textarea)"
angle: ui-shared-foundation
severity: low
category: a11y
is_workaround: false
subsystem: "src/components/Sidebar, src/components/RemoteDesktop"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - src/components/Sidebar/AgentSetupDialog.tsx:518
  - src/components/Sidebar/AgentSetupDialog.tsx:519
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:395
  - src/components/TunnelEditor/TunnelEditor.tsx:524
  - src/components/WorkspaceEditor/WorkspaceEditor.tsx:231
---

## What

AgentSetupDialog renders `<label className="agent-setup-dialog__label">Remote Install Path</label>` followed by an `<Input>` with no id, htmlFor or aria-label, so the label is not associated and the input is unnamed. The neighbouring arch select is wired correctly with htmlFor. The RD clipboard panel uses a raw `<textarea>` with only a placeholder, bypassing ui/Textarea and having no label. TunnelEditor:524 and WorkspaceEditor:231 also contain `<label>` elements that label nothing.

## Why it matters

Screen readers announce 'edit text' with no name for the agent install path, a field that decides where a remote binary is written, and for the clipboard text box. ui/Field (label + htmlFor + error) exists precisely to prevent this, and these are the remaining hand-written field wrappers left after UISF-012/#3151.

## Evidence

- `src/components/Sidebar/AgentSetupDialog.tsx:518`
- `src/components/Sidebar/AgentSetupDialog.tsx:519`
- `src/components/RemoteDesktop/RemoteDesktopTab.tsx:395`
- `src/components/TunnelEditor/TunnelEditor.tsx:524`
- `src/components/WorkspaceEditor/WorkspaceEditor.tsx:231`

## Recommendation

Wrap the install path in `<Field label="Remote Install Path" htmlFor="agent-setup-remote-path">` and give the Input that id. Replace the RD clipboard `<textarea>` with `<Textarea aria-label="Remote clipboard text">`. Change the orphan `<label>`s to headings/spans or associate them with their groups through aria-labelledby.

## Verification

Confirmed. In AgentSetupDialog.tsx:518, the label 'Remote Install Path' has no htmlFor, and the Input below it has no id or aria-label. The RD clipboard is a raw <textarea> with only a placeholder (RemoteDesktopTab.tsx:395). TunnelEditor:524 and WorkspaceEditor:231 have <label> elements not tied to any control.
