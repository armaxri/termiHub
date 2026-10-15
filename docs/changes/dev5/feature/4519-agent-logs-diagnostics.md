### Added

- Export Diagnostics can now include the log files of connected remote agents,
  so a support case no longer needs shell access to the agent host. Each
  connected agent gets one include checkbox in the preview; its per-process
  logs are fetched over the existing connection, redacted on the agent and
  again on this computer, and capped (newest 256 KiB per file, 4 MiB per
  export) under `agents/<agent>/logs/` in the zip. Agents too old to share
  their logs are listed as skipped (#4519).
