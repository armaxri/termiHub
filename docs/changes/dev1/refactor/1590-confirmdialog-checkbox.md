### Changed

- **Confirmation dialogs** now draw their "Don't ask again" opt-out as a
  checkbox instead of a switch, following the distinction established in
  #1562: a checkbox means "takes effect when you confirm", a switch means
  "applies immediately". The opt-out is scoped to the confirmation, so a
  switch overstated its immediacy. This affects the "Insecure Connection"
  FTP warning and the close-tab/close-panel confirmation. Behavior,
  keyboard handling and persistence are unchanged (#1590).
