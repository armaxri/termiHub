### Changed

- Macro rows show the first line the macro types in the normal secondary text, with every line
  in a tooltip, instead of a dim monospace dump joined with ⏎ glyphs; Play's tooltip names the
  terminal it types into, and a "Last run: … on <terminal>" line says when and where the macro
  last played (#5680).
- "Record new" in the Macros toolbar is an icon-only record dot with a tooltip, matching the
  Workflows toolbar: a text primary action and icon secondaries (#5680).
- Macro and workflow run history: run origins are sentence case ("Manual", "Palette",
  "Scheduled", "Workflow step"), both say "No runs yet." when empty, and each run's details stay
  on one line that ellipsizes with the full text in a tooltip; the schedule summary and last-run
  lines do the same, and "Show recent attempts" lines up with the text above it (#5680).
