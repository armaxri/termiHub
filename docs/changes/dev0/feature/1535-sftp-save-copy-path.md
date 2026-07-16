### Changed

- SFTP "Save a copy…" (for read-only remote files on connections with no shell)
  now pre-fills a likely-writable destination instead of the read-only original
  path: the file's name under the connecting user's remote home
  (`<home>/<name>`) when it can be resolved, or a same-directory `<name>.copy`
  sibling otherwise. The field stays fully editable — this only sets a smarter
  initial value so the copy usually saves without manual editing (#1535).
