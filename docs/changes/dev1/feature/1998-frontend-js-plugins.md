### Added

- Frontend JavaScript plugins: an enabled plugin's JS entry point is now loaded
  into the app and can register two kinds of frontend extension through a new
  `window.termihub` API — **protocol parsers** that transform or annotate
  terminal output (`transform(data, sessionId)`, returning `null` to pass a
  chunk through unchanged, with optional `onSessionStart`/`onSessionEnd` hooks)
  and **status-bar widgets** rendered into the left/right status-bar slots
  (`render()`/`dispose()`). Registered parsers run over every terminal output
  chunk before it reaches the screen; registered widgets mount into the status
  bar and are disposed cleanly when the plugin is disabled. Errors thrown by
  plugin code are caught and isolated so one bad plugin cannot break terminal
  rendering or the status bar. Frontend plugins share the WebView context (weak
  isolation, per the plugin-system concept). (#1998)
