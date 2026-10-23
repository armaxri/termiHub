### Fixed

- Transfer view: refreshing the remote pane while its first listing was still loading (for example
  right after picking a newly connected remote) could leave the pane stuck on an empty path with a
  "No such file" error until the remote was picked again. A refresh now waits for the pending
  listing, and after a failed first listing it retries that directory (#4910).
