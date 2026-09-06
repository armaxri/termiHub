### Fixed

- The app no longer crashes to a blank window on Linux hosts running under a
  `C`/`POSIX` locale (common on minimal/headless installs, containers, and some
  SSH sessions). Such environments report `navigator.language` as `"C"`, which is
  not a valid BCP-47 tag; the bundled charting dependency built
  `new Intl.NumberFormat(navigator.language)` at module load, throwing
  `RangeError: invalid language tag: C` and aborting the whole frontend bundle
  before it could mount. The locale is now validated and sanitised to a valid
  fallback (`en-US`) before any consumer reads it, and all in-app locale-aware
  date/number formatting routes through the validated locale (#2646).
