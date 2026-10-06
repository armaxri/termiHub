### Added

- Uploads and downloads on FTP sessions that run through a remote agent now
  appear in the Transfer Queue, with progress, pause/resume, retry and cancel
  (#4113). This needs an updated agent, binary transfer mode and an FTP server
  that supports resuming at an offset (`REST STREAM`); otherwise the session
  keeps the previous one-shot transfer.
