### Fixed

- Remote desktop (VNC/RDP): a failed or aborted connect now looks and behaves
  like a terminal tab's. It shows a plain-language reason with Retry, Edit
  connection and Close tab, instead of a bare "Disconnected" with only
  Reconnect. A rejected password offers the same inline credential re-entry as
  terminal tabs, so a wrong password no longer loops Reconnect → prompt (#5377).
- File-browser (FTP) tabs: a connect can now be aborted, gives up after the
  same 90 s deadline as terminal tabs instead of hanging forever, and fails
  with a plain-language reason, Retry, Edit connection, Close tab and password
  re-entry (#5377).
