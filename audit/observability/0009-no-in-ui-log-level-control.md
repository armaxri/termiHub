---
id: OBS-009
title: No in-UI log-level control; file verbosity only via undocumented env var
angle: observability
severity: low
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/utils/file_log.rs, src-tauri/src/utils/log_capture.rs
evidence:
  - src-tauri/src/utils/file_log.rs:99
  - src-tauri/src/utils/log_capture.rs:26
status: open
---

## What
Log verbosity is not adjustable from the UI. The durable file sink is fixed at INFO and
tunable only via the `TERMIHUB_FILE_LOG` environment variable (`file_log.rs:99`); the ring
buffer / LogViewer level is fixed by `RUST_LOG` / the default directive
(`log_capture.rs:26`). Both require launching the app from a shell with an env var set —
something a typical desktop user (double-clicking an installed app) cannot do, and which is
not documented for end users.

## Why it matters
The standard field-support move is "turn up logging and reproduce." Here that requires a
supporter to walk a user through relaunching the app from a terminal with an env var — on
macOS a bundled `.app` makes even that awkward. Without an in-app "verbose logging" toggle,
raising detail to capture an intermittent failure is effectively out of reach for real users,
so the most useful logs are exactly the ones hardest to obtain.

## Evidence
`file_log.rs:99-107` — file level from `TERMIHUB_FILE_LOG` or the INFO default; deliberately
does not honor `RUST_LOG`. `log_capture.rs:26-28` — ring buffer from `RUST_LOG` or the
default directive. Neither has a runtime/UI control; no Tauri command reconfigures the
filter.

## Recommendation
Add a Diagnostics-panel "Verbose logging" toggle (or level selector) that reloads the
tracing `EnvFilter` at runtime via a `reload::Handle` (tracing-subscriber supports hot filter
reload) for both the file and ring-buffer layers, persisted in settings. Keep the
`russh`/secret clamps applied regardless of level (as the file sink already enforces). At
minimum, document `TERMIHUB_FILE_LOG` in user-facing troubleshooting docs (see OBS-011).
