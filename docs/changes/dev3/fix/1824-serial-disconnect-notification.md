### Fixed

- Serial: a lost COM/serial connection now surfaces as a disconnect instead of
  silently staying "connected". When the port disappears mid-session (adapter
  removed, cable unplugged, read/write error), the reader now closes the output
  channel so the tab's status dot leaves green and the "connection was lost"
  disconnect overlay appears — the same way SSH and local sessions already
  report a dropped connection. Previously the tab stayed green with no
  notification (#1824).
