### Fixed

- File browser multi-delete no longer hides partial failures. Deleting several
  files or folders at once now settles each item independently and reports the
  outcome in a single toast — "Deleted N items" on full success, or "Deleted N
  items, M failed: <names>" when some fail — instead of aborting the whole batch
  on the first error and leaving the result invisible. Single-file delete
  failures are likewise surfaced with an error toast instead of failing
  silently (#1394).
