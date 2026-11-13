### Fixed

- Connecting to a remote agent before it is installed now shows "Agent not
  installed" with a **Set up agent** button. Before, the dialog only said
  "Channel closed before initialize response" and offered no way forward
  (#5608).
- VNC desktops sent as raw 32-bit frames are visible again. The padding byte of
  each pixel was taken as transparency, so many servers showed an empty canvas
  although the session was active (#5608).
- A tab opened after a saved password or passphrase was used to connect now
  reports its live state and reconnects after a dropped connection like any
  other tab (#5608).
