### Added

- Docker file transfers now run through the transfer queue, like SFTP and FTP.
  Uploads and downloads to a container, from the sidebar browser or the
  dual-pane transfer view, show progress and speed. They can be paused,
  resumed, cancelled and retried. Files are streamed in chunks instead of loaded
  into memory, so large files work. A paused or interrupted transfer continues
  where it stopped once termiHub has checked that the source is unchanged. If
  the container lacks the tools needed to check (for example a minimal image
  without `tail` or `stat`), the transfer restarts from the beginning instead
  of risking a corrupt file.
