### Fixed

- Remote desktop: a copy made on the VNC or RDP server now shows up in the open
  clipboard panel straight away. Before, the panel only read the remote clipboard
  when it opened, so "Sync text clipboard both ways" did not work from remote to
  local until you reopened it. If you are typing in the panel when the remote
  clipboard changes, your draft is kept and a "Remote clipboard changed" notice
  lets you apply the new text. Turning off Clipboard Sync stops these updates
  (#4836).
