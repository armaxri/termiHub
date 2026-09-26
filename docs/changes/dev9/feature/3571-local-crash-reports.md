### Added

- Local crash reports: if termiHub (or a remote agent) crashes, a small redacted crash report is
  kept on that machine only — version, platform, the panic message and a backtrace, with
  credentials, host names, IP addresses, usernames and home paths masked and never any terminal
  session content. At most 10 reports are kept, none older than 30 days.
- On the next start after a crash, a non-blocking notice offers to view the report or export
  diagnostics. It can be dismissed, or turned off with "Don't show again" (re-enable under
  Settings → General → Diagnostics).
- **Export Diagnostics…** (settings menu, or Settings → General → Diagnostics) saves a redacted
  zip of the recent logs, crash reports and version/platform info to a location you choose, after
  showing exactly which files it will contain. termiHub still sends no telemetry — nothing leaves
  your computer unless you share that file.
