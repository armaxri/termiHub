### Fixed

- An SSH jump host picked from a connection in an external connection file now
  connects. Saved-connection jump hosts resolve against the same connections the
  editor offers: the main store plus every enabled external connection file
  (#3602).
- A jump host whose id exists in more than one connection file is no longer
  resolved by guessing: the connect fails with a message naming the files, and
  the editor shows the id as unavailable. Renaming one of the connections keeps
  the other files' jump hosts pointing at the one that kept the name.
- A jump host that lives in a disabled external connection file, or in one that
  failed to load, now fails with a message naming that file instead of a bare
  "not found".
