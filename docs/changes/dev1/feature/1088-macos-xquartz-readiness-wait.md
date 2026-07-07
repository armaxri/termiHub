# Changelog fragment — feature/1088-macos-xquartz-readiness-wait

### Fixed

- **macOS X11 forwarding:** After launching XQuartz for an SSH X11 connection,
  termiHub now waits a short, bounded time (~4s, polled every 250 ms) for the X
  server to actually come up before deciding it is unreachable. Previously the
  app re-checked only once, immediately after launching XQuartz — which usually
  fired before XQuartz had created its socket — so the first connect failed with
  a "server unreachable" error and the user had to retry. The wait is cancelled
  promptly if the connection is aborted. (#1088)
