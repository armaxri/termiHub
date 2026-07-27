### Changed

- The persistent-connection ∞ (infinity) badge — and the persistence run-state
  dot — are now shown **only on agent persistent shells**: single-instance
  sessions that live on a remote agent and survive closing termiHub _and_
  powering off / restarting your machine. Its tooltip states that guarantee
  explicitly. Every other connection type (SSH, local shell/CMD, serial, Docker,
  WSL, telnet, ftp, vnc, rdp) is multi-instance and dies with the window, so it
  now shows **no persistence marker at all** — no ∞, no hourglass, and no
  persistence/"connected" state dot. This removes the misleading ∞ that appeared
  on plain SSH and other desktop-local connections (#2086), and drops the brief
  desktop-local Hourglass marker that replaced it, since those connections have
  no persistence to advertise (#2099).
