### Added

- Frontend logging now has a proper ERROR channel. New `frontendError`,
  `frontendWarn`, and `frontendInfo` helpers emit into the user-openable
  LogViewer at their respective levels (previously every frontend log entry was
  hard-coded to DEBUG, so a frontend failure never reached the LogViewer).
- A global handler now routes unhandled promise rejections and uncaught errors
  into the frontend ERROR channel, so fire-and-forget failures that used to
  vanish into the (user-unreachable) DevTools console are now visible in the
  LogViewer.

### Changed

- The React render-crash boundary, the file-editor save-failure path, and the
  config-import read-failure path now record their errors in the LogViewer
  (via `frontendError`) instead of only the DevTools console.
