### Fixed

- The close-tab keyboard shortcut (and its command palette entry) no longer
  closes a tab with unsaved edits without asking. A dirty file, connection,
  settings, tunnel or workspace editor now shows its own unsaved-changes dialog
  with Save, exactly as the tab's close button does, whether or not
  **Confirm close tab on shortcut** is enabled (#4410).
