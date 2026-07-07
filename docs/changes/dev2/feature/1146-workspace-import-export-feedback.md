### Fixed

- Importing and exporting workspaces now report their result instead of
  swallowing every outcome silently. Import shows a success toast with the
  number of workspaces actually imported (so a duplicate-skipping or
  partial import is no longer indistinguishable from importing nothing) and an
  error toast if the file cannot be parsed; export shows a success toast or a
  recoverable error toast if the file cannot be written. Cancelling the file
  dialog stays a no-op with no toast. Part of the workspace save/restore audit
  (#1146, gap G8).
