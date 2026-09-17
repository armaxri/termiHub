### Fixed

- Stopping an embedded HTTP/FTP/TFTP server now shows a brief **Stopping…**
  state before it settles to **Stopped**. The stop path previously jumped
  straight from Running to Stopped without ever emitting the `Stopping`
  transition, so a server that took a moment to tear down looked frozen and then
  suddenly gone. The lifecycle now emits Running → Stopping → Stopped, mirroring
  the Starting → Running transition on start (SM-016).
