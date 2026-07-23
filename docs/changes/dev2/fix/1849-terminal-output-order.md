### Fixed

- Terminal output no longer paints out of order under rapid scrolling output. On
  Windows local CMD (ConPTY), a `git status` with many untracked files could
  render with later prompt lines spliced into the middle of the file list, and
  the glitch only cleared after resizing the tab. xterm's DOM renderer repaints
  only rows it has marked dirty, so during fast scrolling output the WebView
  could leave rows painted at stale vertical positions. The output-flush path now
  forces a full-viewport repaint after each write, so command output always
  renders top-to-bottom in buffer order without a manual resize (#1849).
