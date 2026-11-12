### Fixed

- After the agent is deployed, updated or set up on a Windows host, termiHub now
  saves where it was installed (`%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe`)
  as the agent's path, so the next connect starts it instead of failing on the
  POSIX default `~/.local/bin/termihub-agent`. A host whose login shell is Git
  Bash/MSYS gets the forward-slash form of the path. A custom agent path you set
  yourself is kept (#5522).
