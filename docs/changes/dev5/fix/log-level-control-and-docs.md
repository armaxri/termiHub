### Added

- **In-app log-file verbosity control (OBS-009).** A new **Log File Verbosity**
  setting under **Settings → General → Diagnostics** lets you choose how much
  detail termiHub writes to its log file (Off / Error / Warning / Info / Debug /
  Trace). The change applies immediately — no restart — and is remembered across
  restarts. The control also shows the log file's location so you can find it to
  attach to a bug report. `russh` packet-level logging stays out of the file at
  every level unless explicitly requested via `TERMIHUB_FILE_LOG`.
- **User-facing "Logs and Troubleshooting" guide (OBS-011).** The README now
  documents the in-app Log Viewer, the persistent log file location per platform,
  how to read/export logs, and how to change the verbosity (both the new Settings
  control and the `TERMIHUB_FILE_LOG` environment variable).
