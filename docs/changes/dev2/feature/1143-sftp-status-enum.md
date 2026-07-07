### Changed

- Internal refactor (no user-visible behavior change): the SFTP file browser's
  overloaded `sftpLoading` flag was replaced with an explicit
  `sftpStatus` lifecycle enum (`idle` / `connecting` / `connected` / `listing` /
  `error`), so the UI can reliably tell "connecting" apart from
  "listing"/"refreshing" and show the correct placeholder (audit gap A1, #1143).
