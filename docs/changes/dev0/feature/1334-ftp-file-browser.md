### Added

- FTP directory browsing (backend): the FTP / FTPS backend now implements file
  browsing. It lists directories by preferring the machine-readable `MLSD`
  command and falling back to `LIST`, parsing Unix `ls -l`, Windows/DOS and MLSD
  listings into the shared file model (names, directory flag, size, ISO-8601
  modified time, and POSIX permissions where available), with UTF-8 → Latin-1
  name decoding and symlink handling. File read/write (`RETR`/`STOR`), delete
  (`DELE`/`RMD`), rename (`RNFR`/`RNTO`), stat (`MLST` with a `LIST`-parent
  fallback) and directory creation (`MKD`) are supported. This wires up the
  parsing/CRUD layer; the FTP file sidebar and transfer UI land in follow-up
  steps. (#1334, epic #1331, concept #518)
