### Fixed

- Close-session confirmation dialog: ticking **"Don't ask again"** and then
  **cancelling** no longer disables the confirmation. The preference is now
  saved only when you confirm the close (close the tab/panel) with the box
  ticked; cancelling discards the tick and leaves the setting untouched. This
  matches the checkbox contract used elsewhere (a checkbox applies on confirm,
  not the moment it is ticked) (#1606).
