### Fixed

- The connect / waiting-for-agent timeout is now anchored to a wall-clock
  deadline stored per tab, so dragging a still-connecting tab to another
  panel/split (or a zoom toggle that re-keys the panel tree) no longer restarts
  its countdown. Previously the timer was tied to the overlay component's
  lifetime, so an unmount/remount reset the bound — the advertised "times out in
  N s" was really "N s of continuous overlay mounting". Now the visible
  countdown and the actual timeout fire from the same stored deadline and both
  survive a remount (#1263).
