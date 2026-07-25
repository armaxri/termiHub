### Added

- Broadcast input (target selection): clicking the terminal-view **Broadcast
  Input** toggle now opens a scope dialog instead of starting immediately.
  Choose **All terminals**, **All in current panel**, or **Custom selection**
  (each showing a live target count); custom selection opens a per-terminal
  checkbox picker with Select All / Select None that lists only terminal
  sessions — non-terminal tabs (editors, SFTP) never appear. The chosen scope is
  remembered for next time. Membership is dynamic: under "All terminals" and
  "All in current panel", terminals opened during an active broadcast are added
  automatically (only within the source panel for the panel scope); under
  "Custom selection" they are never auto-added. Closed terminals are removed
  silently (#1956, epic #1954).
