### Fixed

- Local shells now start in a UTF-8 locale when termiHub is launched from Finder,
  the Dock or Spotlight on macOS (or from a Linux desktop session without a
  locale). Previously such shells inherited no `LANG` and ran in the C locale,
  which garbled non-ASCII output, input and filenames. termiHub now sets `LANG`
  from your preferred system locale (falling back to `en_US.UTF-8`), or upgrades
  just `LC_CTYPE` when the inherited locale is plain `C`/`POSIX`. A locale you
  set yourself, including in the connection's environment variables, is never
  overridden (#4336).
