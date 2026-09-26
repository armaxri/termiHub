### Added

- Macros can be played into several terminals at once. The Play Macro dialog has
  a new **Target** picker — this terminal (the default), the current broadcast
  targets, all terminals, the current panel, or a saved broadcast group — with a
  live count of connected terminals. Playing on more than one terminal always
  shows a confirmation that lists every receiving terminal (Enter does not
  confirm it). Each step reaches every target in lock-step; a terminal that
  disconnects mid-run stops receiving, and the summary reports skipped or
  dropped terminals instead of a plain success (PROD-042, #3443).
- Named broadcast groups. In the broadcast dialog's custom selection you can
  save the chosen terminals as a named group; saved groups then appear as
  broadcast scopes and as macro playback targets. Groups remember saved
  connections (not tabs), so they work again after a restart; the dialog shows
  which terminals will receive input, how many members are not open, and warns
  when the terminal you type in is not part of the group. Groups can be
  deleted from the same dialog (PROD-061, #3443).

### Changed

- A multi-line paste into a broadcasting terminal that reaches more than one
  connected terminal now asks for confirmation first, naming the number of
  terminals it will be sent to.
- The broadcast dialog's **Start Broadcast** button shows the number of
  terminals that will receive input.

### Fixed

- Pressing Enter to open a picker in the Play Macro or Broadcast dialog no
  longer also plays the macro or starts the broadcast.
