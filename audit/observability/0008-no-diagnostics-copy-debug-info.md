---
id: OBS-008
title: No diagnostics / "copy debug info" surface; log export has no redaction
angle: observability
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/components/LogViewer, src/components/Settings
evidence:
  - src/components/LogViewer/LogViewer.tsx:101
  - src/components/Settings/UpdateSettings.tsx:86
status: open
---

## What
There is no consolidated diagnostics surface for filing a bug report:

- **No About / diagnostics panel.** The app version is exposed only inside *Update Settings*
  (`UpdateSettings.tsx:86`, `appInfo.version`). There is no place showing OS/build/commit,
  the log-file path, agent versions, or credential-store mode together.
- **No one-click "copy debug info."** A user asked to report a bug must manually gather
  version, OS, and logs from separate places. The LogViewer offers Copy/Save
  (`LogViewer.tsx:101-131`), but that only exports the **in-memory** 2000-entry buffer —
  which by OBS-001 excludes any frontend entries lost on close, and by construction excludes
  anything already rotated out of the ring buffer. The richer, durable `termihub.log` is a
  separate artifact the user has to locate on disk themselves (path documented only in
  testing docs — OBS-011).
- **No redaction on export.** `handleSave`/`handleCopyAll` dump entries verbatim. Backend
  logs are secret-safe by construction (OBS notes the credential/russh hygiene), but there
  is no export-time redaction pass, so any future or frontend-originated entry containing a
  hostname/path/token would be copied as-is into a pasted report.

## Why it matters
Turnkey field support depends on the user being able to hand over a complete, safe diagnostic
bundle in one action. Today the pieces are scattered (version in one dialog, logs in two
places with different contents, no OS/build info anywhere), which makes bug reports
incomplete and slow to triage — the opposite of "run one command, done."

## Evidence
`LogViewer.tsx:101` (`handleSave`) and `:124` (`handleCopyAll`) export `entries` (the
in-memory buffer) with `formatEntry`, no redaction, no inclusion of the on-disk file.
`UpdateSettings.tsx:86-88` is the only version surface. No component matches an
About/diagnostics/"copy debug info" search.

## Recommendation
Add a **Diagnostics / About** panel with a single "Copy debug info" (and "Open log folder")
action that assembles: app version + build/commit, OS/arch, portable-vs-installed, log-file
path, connected agent versions, credential-store mode, and the tail of the **durable** log
(read from `termihub.log`, not just the ring buffer). Run a redaction pass on export (mask
anything matching secret-ish patterns) as defense-in-depth. This is the natural home for the
version/build info every bug report needs.
