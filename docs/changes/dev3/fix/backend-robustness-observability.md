### Added

- Panics are now recorded to the durable application log (`termihub.log`) with
  their message, source location, and a captured backtrace, instead of vanishing
  to a stderr that a bundled desktop app has nowhere to show. A crash — the
  single highest-value diagnostic event — now leaves evidence in the log a user
  is asked to attach to a bug report.
- Frontend errors and warnings now reach the durable application log. Previously
  they only appeared in the in-app Log Viewer and were lost when the window
  closed, so a shared `termihub.log` showed nothing of what the UI actually did.

### Fixed

- The app no longer crashes at launch when its config or data directory cannot
  be created (read-only portable media, a locked-down profile, a full disk, or a
  path that already exists as a file). It now logs the problem and falls back to
  temporary storage so the app still starts, matching the intended behaviour.
