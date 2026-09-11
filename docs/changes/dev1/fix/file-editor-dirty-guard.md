### Fixed

- The file editor no longer silently discards your unsaved edits when a file's
  underlying session/projection identity changes (for example during an
  agent-reconnect cycle). Previously the load effect keyed on the session object
  reference and re-read the file from disk whenever that reference churned for the
  same file, overwriting the in-progress buffer. The load now keys on a stable
  path + session identity and refuses to reload over a dirty buffer, preserving
  your edits (FEC-011).
