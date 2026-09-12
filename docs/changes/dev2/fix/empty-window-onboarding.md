### Changed

- The empty-window screen's **Open Connection…** button now does something
  useful instead of just revealing the (possibly empty) Connections sidebar. With
  saved connections present it opens the command palette so you can fuzzy-find and
  connect one; with no saved connections it takes you straight to the
  new-connection editor rather than dead-ending on a blank Connections panel
  (UX-003).
- The empty-window guidance now speaks to a first-run user ("Start a local
  terminal now, or create a connection to save it for next time.") and only shows
  the multi-window "Tab ▸ Move to Window" hint when more than one window is
  actually open (UX-003).
