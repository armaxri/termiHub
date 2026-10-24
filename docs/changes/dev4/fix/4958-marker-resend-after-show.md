### Fixed

- A command typed right after switching to a terminal tab no longer loses its
  echoed line. When the switch resized the tab, the shell (bash on macOS, or
  ConPTY on Windows) redrew its prompt a moment after the resize and wiped
  input that had already arrived. Input now waits for that redraw, for at most
  a quarter of a second (#4958).
