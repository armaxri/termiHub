---
id: TIN-010
title: Post-install release smoke exists only for Linux; the macOS smoke path only checks that a window opens
angle: test-integration
severity: medium
category: test-gap
is_workaround: false
subsystem: scripts/smoke-test.sh, .github/workflows/release-*-smoke.yml
evidence:
  - .github/workflows/release-linux-smoke.yml:49
  - scripts/smoke-test.sh:222
  - scripts/smoke-test.sh:232
status: open
---

## What

The only post-install release smoke workflows are Linux
(`release-linux-smoke.yml`, `release-linux-arm64-smoke.yml`): they download the
release AppImage/.deb and run `scripts/smoke-test.sh` headlessly. There is **no
macOS or Windows post-install release smoke workflow**.

Worse, `scripts/smoke-test.sh` on macOS does almost nothing: it verifies a window
exists via `osascript` (`:222-227`) and then explicitly `skip`s all UI
interaction — "UI interaction checks (no WebDriver on macOS)" (`:232`). On
Linux/Windows it uses `tauri-driver` if present, else a process-only fallback.

So the display-native macOS build — the platform the app is most used on and the
one `tauri-driver` cannot drive — has its release artifact verified only by
"a window appeared," and Windows has no release-install smoke at all.

## Why it matters

- Release packaging/signing/first-launch regressions on macOS/Windows (bad
  bundle, missing entitlement, blocked webview, crash-on-launch) would not be
  caught by any release-time automated check on those platforms.
- The nightly `system-integration.yml` does launch the app on macOS/Windows, but
  it builds a **debug** bundle from source with the test-CSP overlay — not the
  signed release installer a user downloads, so it is not a substitute for an
  install-the-artifact smoke.

## Evidence

- `release-linux-smoke.yml:49` — "Linux x64 install + smoke"; no macOS/Windows
  equivalent in `.github/workflows/`.
- `smoke-test.sh:204-236` — macOS branch: window check only, UI checks skipped.

## Recommendation

- Add macOS and Windows release-install smoke workflows that download the signed
  artifact, install/launch it, and assert clean startup + `--version` + clean
  shutdown (the process-level checks `smoke-test.sh` already has for the
  fallback path work cross-platform).
- For macOS UI verification, reuse the **Python bridge** (which *can* drive
  WKWebView) against the installed release build with the bridge enabled, so the
  macOS smoke does more than "a window appeared."
