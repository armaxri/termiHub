### Fixed

- Store load and persist failures are no longer swallowed by an invisible
  `console.error`. Every catch block in the app store now routes through the
  in-app logger (`frontend::app_store`), so failures are visible in the
  LogViewer, and the user-facing cases — failing to load connections at
  startup, save settings, or reload external connection files — now also raise a
  recoverable error toast instead of failing silently (#2068).
