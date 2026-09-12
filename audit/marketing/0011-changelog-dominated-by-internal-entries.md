---
id: MKT-011
title: 0.1.0 CHANGELOG reads as internal dev notes (test/CI-heavy), not user-facing release notes
angle: marketing / maturity signal
severity: medium
category: docs
is_workaround: false
subsystem: CHANGELOG.md
evidence:
  - CHANGELOG.md:18
  - CHANGELOG.md:20
status: open
---

## What
The `0.1.0` CHANGELOG is **1,536 lines / ~749 bullets** and is dominated by internal
engineering entries rather than user-facing highlights. Of the bullets, **63 are prefixed
"Testing:"** (plus 10 "Windows:", 10 "CI:", 2 "Tests:") — and the *first* several entries a
reader sees at the top of the 0.1.0 section are all test-infrastructure ports (e.g. "ported the
Windows-shells & WSL infrastructure suite to the Python bridge harness", CHANGELOG.md:22+).
Each entry is a multi-sentence internal-detail paragraph citing issue/PR numbers.

There is one good user-facing summary line (CHANGELOG.md:20), but it's buried under the
raw-changelog wall.

## Why it matters
For a public v0.1.0, the changelog is a **maturity signal** prospects and packagers read. A
changelog that opens with test-harness porting and reads like a commit log (rather than "what's
new for you") makes the release look like an internal milestone rather than a polished public
launch. It also makes it impossible to skim "what does 0.1.0 give me."

## Evidence
- `CHANGELOG.md` — 749 bullets; prefix histogram: Testing 63, Terminal 36, UI 21, Agent 19,
  Settings 18, SSH 17, Monitoring 11, Windows 10, CI 10, …
- `CHANGELOG.md:22+` — top entries of the 0.1.0 section are Testing-infrastructure ports.

## Recommendation
- Add a curated **"Highlights"** block at the top of the 0.1.0 section: 8–12 user-facing bullets
  (connections incl. RDP/VNC, remote agents, session restore, plugins, network tools, tunnels,
  themes, credential encryption). Keep the exhaustive list below under a "Full changelog"
  fold/heading.
- Drop or collapse internal Testing/CI entries from the user-facing changelog (they belong in
  commit history / release-engineering notes), or group them under a single "Testing &
  infrastructure" sub-heading rather than as top-of-list items.
- Write release notes for humans first; the auto-consolidated fragment dump is a second tier.
