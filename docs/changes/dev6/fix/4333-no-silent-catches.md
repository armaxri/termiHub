### Fixed

- Failures that used to vanish without a trace now give feedback (#4333):
  - The Log Viewer reports a failed clear, save or copy with an error toast, and
    confirms a successful save.
  - Opening the Remote Desktop clipboard panel reports when the remote clipboard
    cannot be read.
  - Portable-mode settings report when the config file list cannot be loaded.
  - Best-effort background work (unsubscribes, watch teardown, task cancels,
    drag-out staging cleanup, session-owner refresh, and similar) now writes a
    Log Viewer entry when it fails.
- Error toasts for session logging and Remote Desktop clipboard/file actions now
  stay until dismissed, like every other error toast, instead of disappearing
  after a few seconds (#4333).
