### Fixed

- RDP: a remote desktop under Match Window scaling now reliably follows the tab's
  size against xrdp servers. A size requested right after connecting or after an
  automatic reconnect is kept until the server's Display Control channel is ready,
  instead of being dropped. termiHub no longer sends frame acknowledgements while
  the server applies the new size, which crashed xrdp's session (every xrdp
  release up to 0.10.4). It also re-sends a size that xrdp ignored while it was
  still logging the session on, and keeps the session up when channel traffic
  arrives during the resize instead of ending it with "The RDP server's display
  reconfiguration failed" (#4845).
