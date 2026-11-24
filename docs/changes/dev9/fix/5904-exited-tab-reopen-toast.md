### Fixed

- Closing a terminal tab whose shell has exited shows the "Closed “…” · Reopen" toast again,
  and several such closes still share one "Closed N tabs" toast (#5904). While an ended
  session's notice showed, the toast stack treated the whole terminal pane as off-limits and
  held success toasts back, and the held-back toast was lost when it was shown again. Undo
  offers now always show at once, and the stack only keeps clear of the notice card.
