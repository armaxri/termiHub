### Fixed

- The file browser's failed-listing state is no longer a dead-end (SM-008). When
  a remote (SFTP / session) directory listing fails, the error placeholder and
  the inline error banner now offer **Retry** — which re-invokes the listing and
  shows a pending state while it runs — and **Dismiss**, which clears the error
  and returns the browser to a usable state. Repeat failures re-surface the
  inline error.
