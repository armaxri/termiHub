### Changed

- The automation editor writes a Ctrl key the same way in an open and a collapsed step (`⌃C`, not
  `\x03` or `^C`), and Enter one way (`⏎`): keys typed as `\r` or `\x03` read as `⏎` and `⌃C` once
  the row is left, and the button beside a row says "Add ⏎".
- While an automation cannot be saved yet, Save and "Save and run" look unavailable, as the note
  beside them says; pressing them still shows what is missing.
- The editor keeps one order for every automation: the steps first, then "When it runs".
