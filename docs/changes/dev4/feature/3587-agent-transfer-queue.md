### Added

- Uploads and downloads on SSH, Docker, WSL and local sessions that run through
  a remote agent now appear in the Transfer Queue, with the same progress,
  pause/resume, retry and cancel controls as direct sessions (#3587). The agent
  must be updated; an older agent, and agent-hosted FTP sessions, keep the
  previous one-shot transfer.
