### Added

- File browser symbolic-link support now extends to the Docker, WSL, and SFTP
  backends (follow-up to #1513). Docker link rows are detected via the `find`
  `%y`/`%Y` type fields and carry their `%l` target; the SFTP browsers resolve a
  best-effort `readlink` target for link rows only; and the WSL browser flags
  links via `symlink_metadata` over the UNC path and reads their target. These
  rows now show the distinct link-badge icon and, where the protocol carries it,
  the `→ target` hint — matching the FTP/local behavior. Closes #1523.
