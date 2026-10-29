### Changed

- Opening a connection now shows one shared, live connecting screen for every
  connection type (local shells, SSH, telnet, serial, Docker, WSL, agent
  sessions, RDP/VNC and file-only connections). It replaces the lone spinner,
  which could look frozen. A ring fills toward the connect timeout while a dot
  orbits it, and a step bar shows how far the connect has got: SSH goes
  Resolve → Connect → Host key → Authenticate → Shell, telnet Resolve →
  Connect → Session, serial Open port → Session, and agent sessions Agent →
  Start session. A status line shows what is happening right now, for example
  "Trying public key ~/.ssh/id_ed25519". The animation runs without JavaScript
  timers and respects the system's reduce-motion setting (#5068).
- While connecting, **Abort** is the only button; the tab's own × closes the
  tab. A failed, timed-out or aborted connect marks the step it stopped at and
  offers **Retry** and **Close tab** (#5068).
