### Fixed

- File browser **Paste** now always gives feedback. A successful paste shows a
  success toast; a failed one (permission denied, disk full, and so on) shows an
  error toast with the reason and keeps a cut clipboard so you can retry,
  instead of failing silently. Paste now uses the same checks as drag-to-move
  and Move to…: it asks before replacing an item with the same name, refuses to
  paste a folder into itself, and says so when the items are already in the
  folder. Pasting remote items into a local folder, which is not supported,
  now says so instead of doing nothing. A Save-as or file picker that fails to
  open, and a failed copy from dropping files onto the local browser, also show
  an error toast now (#3458).
