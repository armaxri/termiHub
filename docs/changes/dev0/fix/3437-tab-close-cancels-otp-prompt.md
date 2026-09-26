### Fixed

- Closing a tab (or cancelling the connect) while its SSH connection waits for a
  one-time code now cancels that code prompt right away: the dialog closes and
  the connect stops instead of waiting out the prompt timeout. This covers
  direct SSH connections and SSH connections a remote agent authenticates (the
  agent is told the prompt was cancelled, and a session it still finishes
  creating is closed). Prompts of other tabs stay open (#3437).
