### Added

- **Transfer Queue panel** — a connection-type-agnostic panel docked directly
  above the status bar shows every file transfer as it happens. Each row shows
  the direction (up/down), file name, remote path, a colour-coded progress bar,
  percent, and live throughput, plus state-appropriate controls: **Pause** and
  **Cancel** while active, **Resume** while paused, and **Retry** / **Remove** on
  finished rows. The panel covers all six transfer states — queued, active,
  paused, completed, failed (with the retry-attempt counter and error), and
  cancelled — and a footer offers **Clear Completed** and **Cancel All**. It
  reflects live backend `transfer-progress` events and drives the generic
  pause/resume/cancel/retry commands from the shared transfer-queue model
  (Epic #1331, concept #518).
- **Minimized transfer indicator** — the panel collapses to a compact, clickable
  status-bar indicator that shows a live count of in-progress transfers and
  re-expands the panel on click, so an active transfer never forces the panel to
  stay open.
