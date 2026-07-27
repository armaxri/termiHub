### Fixed

- UI: the Ctrl+F terminal search bar is visible again, and borders render across the
  Tunnel, Workflow, Macro, Recent Sessions, Embedded Server, Update Notification and
  Plugin Settings surfaces. A design-token migration had left `var()` references pointing
  at token names that no longer exist (`--border-color`, `--background-secondary`,
  `--input-background`, `--tab-bar-bg`, `--tab-hover-bg`), so those properties resolved to
  nothing — rendering the search bar transparent and dropping borders across 13+
  stylesheets. Each dangling reference now points at its current token.
