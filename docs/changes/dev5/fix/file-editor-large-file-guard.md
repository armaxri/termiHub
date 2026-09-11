### Fixed

- The built-in file editor no longer freezes or crashes when a very large file
  is opened (a double-click away for a big log or data dump). It now checks a
  file's size before loading and, above 10 MiB, refuses to load it blindly:
  instead of streaming the whole file into the editor it shows a warning with
  the file's size and an "Open anyway" button, leaving the user in control.
  Ordinary files open exactly as before. The same guard applies to the
  automatic reload-on-external-change path, so a watched file that grows past
  the threshold is not re-read automatically — a banner offers a manual
  "Reload anyway" instead (PROD-014, PERF-002).
