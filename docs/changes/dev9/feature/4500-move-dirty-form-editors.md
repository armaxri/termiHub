### Changed

- **Move tabs** on window close now carries connection, tunnel and workspace editors with
  unsaved changes instead of asking you to save or discard them first. Each reopens in the
  destination window with your edits, still unsaved. Passwords and other secrets typed into a
  connection form are not copied to the other window: those fields reopen empty, and the close
  dialog names them so you can type them again there before saving (#4500).
