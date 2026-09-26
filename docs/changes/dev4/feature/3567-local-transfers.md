### Added

- Large local file copies now run through the transfer queue, like SFTP, FTP
  and Docker transfers. Copying or pasting a file bigger than 8 MiB between
  local folders, saving a local file elsewhere, or dropping one onto the local
  file browser shows progress and speed, and can be paused, resumed, cancelled
  and retried. This includes copies between Windows folders and a WSL
  distribution. The copy is written to a hidden temporary file and only takes
  the destination name once it is complete, so a cancelled or failed copy never
  leaves a half-written file behind, and an existing file at the destination
  is kept until the new copy has finished. Smaller files and folders are still
  copied directly.
