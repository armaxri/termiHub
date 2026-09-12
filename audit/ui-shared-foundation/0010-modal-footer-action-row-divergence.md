---
id: UISF-010
title: Modal footer action-row markup is inconsistent — some wrap in a bespoke __actions div, some don't
angle: ui-shared-foundation
severity: low
category: ui
is_workaround: false
subsystem: src/components/ui/Modal
evidence:
  - src/components/ui/Modal.tsx:127
  - src/components/RemoteDesktop/RemoteDesktopCertPrompt.tsx:47
  - src/components/SshHostKeyPrompt/SshHostKeyPrompt.tsx:77
  - src/components/Sidebar/ConnectionErrorDialog.tsx:47
  - src/components/ConnectionEditor/UnsavedChangesDialog.tsx:24
status: open
---

## What

`Modal` already wraps whatever is passed as `footer` in `div.ui-modal__foot` (Modal.tsx:127). But
dialogs disagree on what to put inside it: some pass a bare `<>…</>` fragment of Buttons
(`ConnectionErrorDialog.tsx:47`, `UnsavedChangesDialog.tsx:24`, `LocalProcessAuthDialog.tsx:37`,
`CloseWindowDecisionDialog.tsx:69`), while others add their **own** action-row wrapper div inside the
footer — `RemoteDesktopCertPrompt.tsx:47` (`rd-cert__actions`) and `SshHostKeyPrompt.tsx:77`
(`ssh-hostkey__actions`). So footer button spacing/alignment is defined in two places (Modal's
`ui-modal__foot` and per-dialog `__actions` CSS) and drifts.

## Why it matters

There is no single owner of footer button layout (gap, alignment, order). New dialogs copy whichever
neighbour they saw, so some footers right-align via `ui-modal__foot`, others via a nested `__actions`
rule with different spacing. It is a small but pure consistency gap in the modal foundation.

## Evidence

- Owner: `src/components/ui/Modal.tsx:127` wraps footer in `ui-modal__foot`.
- Redundant nested wrappers: `RemoteDesktopCertPrompt.tsx:47`, `SshHostKeyPrompt.tsx:77`.
- Bare fragments (the majority): `ConnectionErrorDialog.tsx:47`, `UnsavedChangesDialog.tsx:24`, etc.

## Recommendation

Export a `ModalFooter`/`DialogActions` helper (or document that footer content must be a bare
Button run and that `ui-modal__foot` owns spacing) and remove the per-dialog `__actions` wrappers.
This also feeds the shared action-row used by the ContentOverlay primitive in UISF-008.
