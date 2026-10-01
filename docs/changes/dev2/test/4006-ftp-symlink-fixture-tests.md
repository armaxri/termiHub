### Fixed

- FTP: symbolic links on ProFTPD servers now show up in the file browser.
  ProFTPD reports links in machine-readable listings as `OS.unix=symlink`,
  which termiHub did not recognise, so those entries were silently left out.
  They are now listed and marked as links (#4006).
- Transfer queue: retrying a transfer by hand after it failed three times now
  works properly. The retried transfer ran, but its row stayed "failed" even
  after the file arrived (#4006).

### Internal

- New live fixture tests (#4006): FTP symlink listing and following, explicit
  and implicit FTPS against a test CA, the FTP transfer queue under faults (a
  dropped session, a stopped server, cancel, pause/resume), SFTP and Docker
  symlink listing, and SSH monitoring going stale and recovering when its host
  is paused.
