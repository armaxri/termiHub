### Fixed

- Connecting a saved SSH connection from the sidebar or command palette no longer
  leaves a dead pause after the click. The slow pre-connect steps (credential-store
  unlock, stored-credential resolve, and the blocking pre-connect handshake) now
  show a lightweight, non-blocking "Connecting…" indicator that is cleared the
  moment the tab (and its own connection overlay) or the password prompt takes over
  the feedback (UX-011).
- Cancelling the password prompt on a sidebar/command-palette connect now shows a
  brief "Connect canceled" acknowledgement instead of returning silently, matching
  the connection editor's connect-cancel feedback (UX-012).
- When a saved credential is rejected by the server, the re-prompt now explains why
  it appeared — the password dialog shows "Saved password was rejected — please
  re-enter." (or the passphrase equivalent) as context — so an auto-cleared stale
  credential no longer re-prompts the user without explanation. The reason is
  surfaced inside the prompt rather than as a separate mid-connect error toast, and
  the destructive credential clear still gates only on the typed auth-failure code,
  never on localized message text (UX-013).
