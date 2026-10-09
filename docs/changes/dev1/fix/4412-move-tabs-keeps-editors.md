### Fixed

- Windows: closing a window with "Move tabs" now carries file editors with unsaved changes,
  including the unsaved text, to the other window instead of discarding them. An editor
  whose unsaved changes cannot be moved (connection, tunnel, workspace or settings editors)
  blocks the move until you save or discard it (#4412).
