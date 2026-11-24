### Fixed

- Closing a tab while the "Closed … · Reopen" toast is still offered now always adds the tab to
  that toast, even more than 6 seconds after the previous close (#5919). Before, a close after a
  slow confirm dialog, or while the pointer held the toast open, replaced the toast and lost the
  undo for the tabs closed earlier.
