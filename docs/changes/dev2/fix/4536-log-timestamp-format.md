### Fixed

- The Log Viewer now shows frontend and backend entries in one timestamp format
  (24-hour local time with milliseconds, in the UI locale) and lists them in
  chronological order: on open, buffered backend logs are interleaved with the
  frontend history by time instead of being stacked in front of it. Saved and
  copied logs use ISO-8601 UTC timestamps for every entry (#4536).
