### Fixed

- SSH: on a fish 3 login shell, a session with configured environment variables
  no longer shows termiHub's typed setup line. fish 3 draws a long line word by
  word and then repaints it on Enter; termiHub now recognises the whole redraw
  and hides it. Verified against a real fish 3.6 (#5115).
