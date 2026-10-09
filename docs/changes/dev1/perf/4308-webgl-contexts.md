### Fixed

- Terminals no longer lose GPU rendering when many tabs are open. Only terminals
  on screen now hold a WebGL context, from a pool capped below the WebView's
  limit, so opening more than 16 tabs no longer drops the oldest ones to the
  slower renderer for good. A terminal whose GPU context was lost switches back
  to GPU rendering the next time its tab is shown (#4308).
- Closing a terminal tab with a large scrollback is faster: the scrollback is
  no longer serialized when the tab is closed, only when a reconnect needs it
  (#4308).
