### Added

- FTP transfers and remote-to-remote copies can now be resumed after restarting the app, like
  SFTP, Docker and local transfers (#3206). A resumed FTP transfer continues from where it
  stopped when the server supports `REST`; otherwise it restarts from the beginning. The source
  file's size and modification time (via `MDTM`, when the server supports it) are checked first,
  so a file that changed while the app was closed is copied again from the start.
