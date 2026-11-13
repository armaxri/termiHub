### Changed

- Remote desktop: a VNC or RDP tab whose session is connected but has not
  painted a picture yet now shows its connect stages (SSH tunnel for a
  tunnelled session, connect, authenticate, first frame) instead of a blank
  pane. After 20 seconds without a picture it shows "No picture from the remote
  desktop" with Retry, Edit connection and Close tab (#5626).
- Remote desktop: the status bar shows the resolution and colour depth only
  once the first frame has painted, names the SSH gateway of a tunnelled
  session ("via SSH user@host"), and spaces its icon from the text (#5626).
- VNC / RDP editor: the SSH tunnel section now sits right below Host and Port
  instead of after the display and protocol options (#5626).
