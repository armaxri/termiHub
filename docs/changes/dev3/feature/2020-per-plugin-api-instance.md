### Fixed

- Frontend JavaScript plugins now register through their **own** per-plugin
  `termihub` API instance, so a parser or status-bar widget registered
  **asynchronously** (from a `setTimeout`, `Promise`, or `load`/`DOMContentLoaded`
  callback) is attributed to the correct plugin and is fully removed — script and
  registrations — when the plugin is disabled or uninstalled. Previously only
  synchronous, top-level registration was attributed correctly; async
  registrations landed under an `"unknown"` id and leaked past disable. The
  concept-mandated `window.termihub` remains available as a shared fallback.
  (#2020)
