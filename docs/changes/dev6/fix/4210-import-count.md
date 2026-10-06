### Fixed

- Importing connections now reports only the connections it actually added.
  Connections already in your list are skipped (as before), but the success
  message used to count them as imported — re-importing your own export said
  "Imported 6 connections" while nothing changed. It now reads, for example,
  "Imported 2 connections, skipped 4 that already exist", or "Nothing imported —
  all 6 connections already exist" (#4210).
