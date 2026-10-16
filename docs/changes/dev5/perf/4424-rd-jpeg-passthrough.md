### Changed

- Remote desktop (VNC): photo and video areas that the server sends as JPEG
  (Tight encoding) now reach the window still compressed and are decoded
  there, so these updates cost roughly a tenth of the data they did before.
  If the window cannot decode one, it switches back to plain pixels and
  repaints the whole screen, so the picture never shows garbage (#4424).
