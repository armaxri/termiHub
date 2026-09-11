### Fixed

- Right-clicking to copy a terminal selection (quick-action mode) now clears the
  selection only after the clipboard write succeeds, and surfaces an error toast
  if it fails — previously a failed copy silently cleared the selection, so the
  user believed they had copied when they had not (FEC-018).
- A terminal whose xterm element was adopted into its split-view slot via the
  first-render retry path is now parked back correctly when the slot unmounts,
  instead of being left orphaned in a detached node (a DOM/terminal-instance
  leak on a tab's final close, FEC-012).
- While a file-editor tab is zoomed, the in-panel editor no longer runs a second
  on-disk file watch or briefly blanks the editor status bar — the zoom overlay
  is now the sole authoritative editor for that file (FEC-018).
