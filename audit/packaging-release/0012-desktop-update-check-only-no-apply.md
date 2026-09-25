---
id: PKG-012
title: Desktop "auto-update" is check-only (manual download); the update subsystem exists but never applies an update
angle: packaging-release
severity: info
category: ux
is_workaround: false
subsystem: src-tauri/src/commands/update.rs
evidence:
  - src-tauri/src/commands/update.rs:178
  - docs/release-plan-0.1.0.md:518
status: open
---

## What
The desktop app has a fully-built update **detection** subsystem — polls the GitHub
releases API hourly, compares semver, honours a "skip this version" setting, flags
security releases via the `<!-- security -->` marker — but it never downloads or
installs anything. There is no download/verify/apply command for the desktop bundle.
The user is shown a notification and pointed at the GitHub release page to download
the new installer by hand. Meanwhile the release plan's known-limitations list states
plainly "No auto-update — users must manually download new versions".

## Why it matters
This is a posture note, not a defect: check-only is a defensible (and, given the
absence of update signing per PKG-003, safer) choice for a beta. It is flagged so the
scorecard is honest about it and so two loose ends are visible: (1) the app invests in
security-release detection / non-skippable prompts (#1878) that then dead-end at "go
download it yourself", a somewhat inconsistent UX; (2) if in-app auto-apply is ever
added, it must land **with** signature verification (PKG-003), not just the checksum
model the agent uses.

## Evidence
- `src-tauri/src/commands/update.rs:178-241` — `check_for_updates` returns
  `UpdateInfo` (available/version/notes/is_security); the file has no download or
  install command, only check + settings persistence.
- `release.yml:46-58` — release notes carry a security marker the app greps for, i.e.
  the machinery around updates is non-trivial despite there being no apply path.
- `docs/release-plan-0.1.0.md:518` — "No auto-update" listed as a known limitation.

## Recommendation
Keep check-only for the beta and make the UX consistent: the update prompt should
clearly state it links to a manual download (not an in-app install), and the
security-release non-skippable path should make sense in a "download it yourself"
world. When/if in-app apply is implemented, gate it on signature verification and the
Tauri updater plugin (see PKG-003).
