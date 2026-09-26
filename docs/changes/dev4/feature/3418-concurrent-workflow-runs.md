### Changed

- **Run on…** now runs a workflow on the chosen terminals at the same time instead of one
  after another. Up to 8 terminals run at once; any beyond that wait and start as soon as
  one finishes. Untick **Run in parallel** in the picker to run them one after another as
  before. While the workflow runs, the Workflows panel lists each terminal with its step
  progress and its own **Stop** button, and **Stop all** cancels every terminal (including
  ones still waiting). The progress toast shows how many terminals are running, queued,
  done, or failed. A failure on one terminal never stops the others, parameters are still
  asked once, a local-process step asks for permission once for all terminals, and every
  terminal still gets its own run-history entry.
