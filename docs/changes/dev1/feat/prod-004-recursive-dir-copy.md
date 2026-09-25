### Fixed

- Copying or cutting a **directory** in the file browser and pasting it into a
  remote session now transfers the whole folder with all of its contents.
  Previously a pasted folder was treated as a single file, so its contents were
  silently dropped (PROD-004). A copy between two locations on the same
  SFTP/SSH session uses a single recursive server-side copy; cross-session,
  local-to-remote, and byte-based (Docker/agent) pastes recreate the directory
  tree on the destination and transfer each file through the transfer queue.
