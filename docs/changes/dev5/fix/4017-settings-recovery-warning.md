### Fixed

- A corrupt `settings.json` is again reported at startup: the app resets it to
  defaults, keeps a `settings.json.bak` backup and shows the recovery dialog. An
  early read of the file-log level had been silently resetting the file before
  the recovery check ran, so the warning never appeared (#4017).
