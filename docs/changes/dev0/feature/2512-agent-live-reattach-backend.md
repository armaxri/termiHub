### Added

- Resilient **agent**-hosted terminal tabs now re-attach to the **same live
  session** when their connection drops and reconnects, so a long-running
  process (e.g. a compile) keeps running across the disconnect and simply
  continues on reconnect — instead of the desktop starting a fresh shell and
  orphaning the recovered session. When the live agent session genuinely cannot
  be recovered (the agent restarted, or the session aged out), the tab now
  surfaces an explicit **session-lost** state rather than silently opening a new
  shell. Backend groundwork, gated behind the default-off `sessionBackendReattach`
  flag (no user-visible change yet; the frontend notice and "start new shell"
  action follow separately) (part of #2512).
