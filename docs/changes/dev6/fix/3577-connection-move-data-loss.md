### Fixed

- Connections: moving a connection that sits in a folder into a connection
  file (or the main store) that lacks that folder no longer loses it. It keeps
  its folder when the main store has it (the folder is copied into the file),
  otherwise it moves to the root. A move whose target cannot be written now
  leaves the connection where it was, and a move onto a same-named connection
  keeps both (the arriving one becomes `name (1)`). Saving an external-file
  connection into a folder the file lacks no longer drops it either (#3577).
- Credentials: saved passwords and key passphrases now follow every connection
  id change — including a sibling renamed to `name (1)` by a rename, external
  file renames, folder renames and deletes, and moves between files. All
  changes of one operation are applied together, so a rename can no longer
  overwrite another connection's saved password, and an old secret is only
  removed after its new copy is written. Sudo passwords now move too (#3578).
