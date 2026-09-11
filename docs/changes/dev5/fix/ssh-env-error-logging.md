### Fixed

- SSH environment-variable, X11-forwarding, and WSL input failures are no longer
  swallowed silently. When the server rejects a `SetEnv` request, when the
  `export`/`DISPLAY`/`xauth` injection into the shell fails, when an X11 forward
  stream errors, or when a WSL PTY write fails, termiHub now logs a diagnostic
  (WARN for a configured feature not applying, DEBUG for expected stream ends) so
  a configured env var or X11 app that "just doesn't work" leaves a trace in the
  log for support. Secret values are never logged — only the env var name and the
  error (the export line and the MIT-MAGIC-COOKIE-1 xauth cookie stay out of the
  log). Behavior is otherwise unchanged: these paths remain best-effort and
  non-fatal (WA-RS-008 / ERR-007 / OBS-006).
