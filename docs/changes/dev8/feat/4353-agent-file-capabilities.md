# Changes

## Added

- The file browser now offers **Permissions**, **Owner** and **New symlink** for
  agent-hosted SSH and local sessions, matching a direct SSH session. The actions
  follow what each session's backend really supports, so Docker, FTP and WSL
  sessions still do not show them (#4353).
