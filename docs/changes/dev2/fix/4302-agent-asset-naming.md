### Fixed

- Agent: deploying the remote agent to a Windows host no longer fails with a 404 —
  the desktop now downloads the published `termihub-agent-windows-<arch>.exe`, and dev
  builds publish Windows x64 and ARM64 agents too (#4302).
- Agent: a macOS agent with self-update enabled now finds its published update binary
  (#4302).
