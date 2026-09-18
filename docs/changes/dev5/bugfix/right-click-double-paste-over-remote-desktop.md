### Fixed

- Right-click paste into a terminal no longer inserts the clipboard text twice
  when termiHub is accessed over Windows Remote Desktop (mstsc, the OS
  session-remoting — unrelated to termiHub's own RDP connection type). The
  previous 50 ms paste debounce was too tight for the remote-desktop input
  relay, whose duplicated context-menu event arrives well beyond 50 ms; the
  per-tab debounce window is now wide enough to absorb that relay jitter, and
  the right-click quick-action additionally ignores a doubled context-menu for
  the same gesture. Pasting into different tabs and deliberate repeat pastes are
  unaffected.
