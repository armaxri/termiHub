## Changed

- The Services sidebar server actions (Start, Stop, Edit, Duplicate, Delete)
  now use the shared accessible Tooltip for hover help — consistent, themed,
  and reachable on keyboard focus instead of mouse-only. Each icon-only button
  exposes its label as a proper accessible name (`aria-label`) instead of the
  browser `title`. Truncation/full-text hovers on server names, paths, and
  status text are unchanged (#1161).
