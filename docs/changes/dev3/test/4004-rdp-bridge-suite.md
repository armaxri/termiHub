### Fixed

- An RDP connection to a server with an untrusted certificate no longer hangs on
  "connected" with a blank tab when the server answers quickly (a LAN host, a
  local VM). The certificate prompt was raised before the tab had started
  listening for it, so it was never shown and the session waited for a decision
  nobody was asked for. The tab now picks up a prompt that is already waiting
  (#4004).
- Pasting a file copied in an RDP session no longer ends the session when the
  server does not support clipboard file transfer (for example an xrdp session
  another client without file transfer attached to first). Such a copy is no
  longer offered as files, and a file that cannot be fetched fails only its own
  paste (#4004).
- A paste of a file copied in an RDP session no longer waits forever when the
  connection ends while the file is being fetched (#4004).
