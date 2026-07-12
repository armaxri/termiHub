### Fixed

- FTP file browsing now works against real-world servers such as ProFTPD.
  Directory listings previously came back empty because the underlying FTP
  library's `MLSD` parser rejected common server output — four-digit
  `UNIX.mode` values (e.g. `0755`) and the `type=cdir` / `type=pdir` self /
  parent markers — silently dropping every entry. termiHub now parses `MLSD`
  facts lines directly, and `stat` returns the entry's base name (rather than
  the full pathname `MLST` echoes back).
