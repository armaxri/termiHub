### Changed

- Remote desktop (VNC/RDP, direct or through an agent): screen updates now
  reach the window as raw binary data instead of JSON, so each update is
  about a quarter of its former size. Full-screen refreshes, resizes and
  video-heavy desktops repaint faster, with far less CPU and memory use
  (#4291).
