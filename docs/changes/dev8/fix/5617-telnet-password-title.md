### Fixed

- Connections: the password prompt is titled after the connection's transport. A telnet
  connection asked for an "SSH Password", which suggested an encrypted channel; it now
  asks for a "Telnet password" (and VNC/RDP for a "VNC password"/"RDP password"). Titles
  are sentence case ("SSH password", "SSH key passphrase"), the connection name sits on
  its own line instead of wrapping the title, and a key passphrase prompt names the key
  file it unlocks.
