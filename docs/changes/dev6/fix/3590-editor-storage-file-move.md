### Fixed

- Connections: changing a saved connection's storage file in the connection
  editor no longer leaves two copies of it in the target file. The edit and the
  move are now saved in one step, so the connection ends up exactly once in the
  target file, with the edited fields. If the save fails, the editor stays open
  and the connection stays where it was (#3590).
