### Changed

- Byte-size, transfer-rate and relative-time readouts (file browser, transfer
  queue, embedded-server stats, status-bar monitoring, tunnel stats, connection
  overlays) now share one set of formatters and render their numbers through the
  app's resolved UI locale, so digit grouping and the decimal separator follow
  the user's locale instead of always using an English `.` (LIBFE-002, I18N-015).
