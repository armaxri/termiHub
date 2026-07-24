### Added

- Workflow Manager: a `run-local-process` step now streams its output into a
  dedicated inline run-output panel at the foot of the Workflow sidebar, instead
  of only the LogViewer. The panel shows the process's stdout/stderr live as it
  arrives (stderr tagged distinctly), a running/completed/cancelled/failed status
  indicator, the command being run, and the final exit outcome (exit code,
  timeout, or cancellation). It reuses the existing streamed-output events, adds
  no new backend channel, and stays visible after the run ends until dismissed
  (#1865).
