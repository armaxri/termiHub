### Fixed

- Saved connections no longer "resurrect" after a failed delete. Deleting,
  adding, duplicating, or editing a connection performs two independent
  operations — an immediate update to the in-memory connection tree and a
  separate write to `connections.json` — and the two were uncoupled. If the
  on-disk write failed (a read-only external file, a permission or disk error, a
  race), the sidebar showed the change applied while disk still held the old
  state, so a deleted connection reappeared (and a never-saved add/duplicate
  vanished) on the next app start. The optimistic tree change is now reverted the
  moment its paired disk write is rejected, so the sidebar stays consistent with
  what is actually on disk and the error toast is the only surviving signal
  (FES-005).
