### Fixed

- An RDP connection to a server with an untrusted certificate no longer hangs on
  "connected" with a blank tab when the server answers quickly (a LAN host, a
  local VM). The certificate prompt was raised before the tab had started
  listening for it, so it was never shown and the session waited for a decision
  nobody was asked for. The tab now picks up a prompt that is already waiting
  (#4004).
