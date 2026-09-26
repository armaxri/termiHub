### Added

- Macros can now be written by hand, not only recorded. The Macro Manager has a
  **New** button (and a "write one by hand" link when the library is empty) that
  opens the macro editor blank. In the editor each step's input is an editable
  text field — so a typo in a recorded command can be fixed without
  re-recording — and **Add Step** appends a new one. Control keys use a short
  escape notation: `\r` Enter, `\n` line feed, `\t` Tab, `\e` Esc, `\xHH` any
  other control byte (e.g. `\x03` for Ctrl+C) and `\\` for a literal backslash;
  a per-step button appends Enter. Invalid escapes or empty steps are flagged
  inline and block Save. Recorded steps are shown in the same notation and are
  saved back byte-identical when left untouched, and authored macros play back
  exactly like recorded ones. (#3440, audit PROD-039)
