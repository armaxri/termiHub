### Fixed

- Browsing files on a Docker connection now works when the container uses a
  non-English locale. The file browser parses the output of `stat` and `find`
  run inside the container; under a localized `$LANG` those became unreliable —
  `stat`'s file-type text was translated (e.g. `Verzeichnis` / `répertoire`),
  so directories and symlinks were mis-detected as regular files, and `find`'s
  modification time used a decimal comma (`1700000000,5`), which failed to
  parse and reset every file's modified date to 1970-01-01. termiHub now forces
  a stable machine locale (`LC_ALL=C LANG=C`) on every parsed container command
  and parses the timestamp defensively, so file types, symlinks and modified
  dates are correct regardless of the container's language. Container error
  messages (`No such file`, `Permission denied`) are also classified correctly
  again.
- Remote system monitoring over SSH now pins a stable machine locale for the
  whole metrics command, so hosts configured with a non-English or
  comma-decimal locale cannot skew the parsed load, memory, disk and uptime
  figures.
