### Added

- Per-session output logging to a file (#1960). A terminal-toolbar toggle
  (`Log Session Output`) starts and stops writing the active session's output to
  a timestamped transcript on demand, and a per-connection Terminal setting
  (`Log Session Output`, with an optional `Timestamp Each Line`) auto-starts
  logging on connect. Transcripts default to
  `<connection>-<timestamp>.log` under the platform log directory's `sessions`
  subfolder, capture every session type (local, SSH, serial, telnet, docker, and
  agent-proxied remote), rotate at a size cap, and are flushed on close.
