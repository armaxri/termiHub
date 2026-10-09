### Fixed

- Unsaved editor work is no longer thrown away without asking:
  - Closing a window that holds an editor with unsaved changes (a remote or local file,
    a connection, tunnel or workspace editor) now opens the close dialog, which lists
    each unsaved editor. Closing a split panel asks the same way.
  - The workflow, macro, schedule and theme editors ask before discarding changes when
    you press Escape, click outside the dialog, click the X or press Cancel.
  - The tunnel and workspace editors ask before Cancel (or Escape in the tunnel editor)
    discards changes, and closing their tab shows the same Save / Just Close / Cancel
    prompt as the connection editor.
- The unsaved-changes prompt for a file tab now says "file" instead of "connection".
