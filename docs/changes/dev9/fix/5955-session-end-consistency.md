### Fixed

- Terminal: every session end now reads the same way (#5955). A local process
  that exits reads "Process exited (code N)" for every code, 0 included, and its
  tab shows a grey stop sign instead of the red network-drop plug. Restarting a
  local shell marks the scrollback "— restarted hh:mm:ss —" instead of
  "— reconnected —". The "[Process exited with code N]" line is written after
  the shell's last output, which could land above it or be lost.
- Terminal: the session-end strip looks and reads the same for local, SSH,
  telnet and agent sessions. It says "Press Enter to restart." or "Press Enter
  to reconnect." like the view-mode banner, and Enter in the ended terminal runs
  it. Its x is the one way to dismiss it: the "View scrollback" button, which
  did the same, is gone. After dismissing, the banner keeps the strip's heading.
- Status bar: the SSH chip greys and says "Not connected" while the session is
  down, instead of showing the green shield of a live secure session.
