### Fixed

- SFTP sessions are now closed when termiHub quits. Previously, open SFTP
  sessions were left dangling on the server until it timed them out; the
  window-destroyed shutdown handler now tears down every open SFTP session
  (alongside the existing tunnel, embedded-server, X-server, and HTTP-monitor
  cleanups). The teardown is poison-safe — a prior panic cannot abort it (#1244).
