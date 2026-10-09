### Fixed

- The Log Viewer shows each frontend warning and error once instead of twice,
  so Copy All Logs and Save All Logs no longer contain duplicates either. Frontend
  entries also survive closing and reopening the Log Viewer, and clearing the
  log keeps it cleared after reopening (#4327).
- Log Viewer **Copy Entry** / **Copy All Logs** and Settings' **Copy debug info**
  now use the native clipboard, so a copy no longer silently fails on macOS
  when the window is not focused. The Log Viewer confirms a successful copy, and
  a failed save or copy is also recorded in the log itself (#4327).
