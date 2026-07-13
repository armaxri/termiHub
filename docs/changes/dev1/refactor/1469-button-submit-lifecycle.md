### Changed

- Submitting a form with **Enter** now shows the exact same pending affordance
  (button spinner + "Working…"/"Switching…"/"Changing…" label) as clicking the
  primary button, across every form. Previously only a mouse click drove the
  async pending state on many forms while Enter ran silently. This now covers the
  Save Workspace dialog and the Security settings master-password setup /
  change-password dialogs, in addition to the Network Tools panels. The
  master-password and change-password dialogs also no longer briefly flash a
  success checkmark when the operation fails — the failure stays an inline error
  (#1469).
