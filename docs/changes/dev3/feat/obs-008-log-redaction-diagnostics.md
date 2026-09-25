### Added

- **Redacted log export** — copying or saving logs from the Log Viewer now masks secrets
  (passwords, passphrases, tokens, API keys, `Authorization`/`Bearer` values, PEM private-key
  blocks, and connection-string credentials) with a `***redacted***` marker before the text leaves
  the app, so logs attached to a bug report can no longer leak credentials in plaintext (OBS-008).
- **Copy debug info** — a new action in Settings → Diagnostics copies a consolidated diagnostics
  summary (app version, build commit/branch, platform, log file path, and credential store mode) to
  the clipboard for pasting into bug reports. The bundle is run through the same redaction (OBS-008).
