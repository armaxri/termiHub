### Added

- Rendered visual checks (`pnpm test:visual`, #4712). They boot the frontend in
  headless Chromium against a mocked backend and render Settings, every sidebar
  and the main dialogs at three window sizes and two sidebar widths. A check
  fails on unloaded CSS, clipped controls, overflow and overlapping text. CI
  runs them on every frontend PR and uploads the screenshots for review.
