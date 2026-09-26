### Added

- VNC connections have a **Resolution** select in the editor's Display group
  (#3463): _Server default_, the default and previous behavior (the remote keeps
  the size its server chose), _Dynamic (follow window)_, which resizes the remote
  desktop to the tab in Match Window scaling, and _Fixed size_, which pins it to
  the width x height below. Dynamic and Fixed need a server that lets clients
  resize the desktop (RFB ExtendedDesktopSize, e.g. TigerVNC); other servers keep
  their size and are scaled locally.

### Changed

- When a remote desktop cannot follow the tab (the server refuses or does not
  support resizing), a one-time notice explains why instead of the failure only
  being logged (#3463).

### Fixed

- After a VNC server changes its desktop size, the whole new framebuffer is
  requested and repainted; refreshes no longer keep asking for the size the
  session started with (#3463).
