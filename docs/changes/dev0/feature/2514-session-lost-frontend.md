### Added

- Resilient agent shell tabs now show an explicit **"Session lost"** notice when a
  reconnect restores the transport but the live agent session could not be
  recovered (agent restarted, aged out, or the daemon died). Instead of silently
  opening a replacement shell, the tab preserves its scrollback and offers a clear
  **"Start New Shell"** action to open a fresh session on demand, alongside "View
  Scrollback". This is the frontend half of the agent live-reattach feature and is
  gated behind the default-off `sessionBackendReattach` experimental flag, so
  there is no change unless it is enabled (#2514, part of #2512).
