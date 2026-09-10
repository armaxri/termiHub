---
id: TIN-004
title: The integration lane builds with a loosened test CSP, so the shipped production CSP is never exercised end-to-end
angle: test-integration
severity: medium
category: test-gap
is_workaround: true
subsystem: src-tauri/tauri.test.conf.json, tests/system/tests/test_csp.py
evidence:
  - src-tauri/tauri.test.conf.json:6
  - .github/workflows/system-integration.yml:250
  - tests/system/tests/test_csp.py
status: open
---

## What

Every integration run builds the app with
`--config src-tauri/tauri.test.conf.json` (`system-integration.yml:250, 489`),
which **overrides the CSP** to re-add loopback WebSocket origins the bridge needs
(`connect-src … ws://127.0.0.1:* ws://localhost:*`) and adds
`dangerousDisableAssetCspModification: ["style-src"]`
(`tauri.test.conf.json:6`). The production CSP (#2059) allows **no** `ws://` in
`connect-src`. So `test_csp.py`'s "no CSP violations were reported" assertion runs
against the **test** policy, not the shipped one.

The workflow comment claims "Everything else in the CSP … is identical to
production, so this lane still exercises the shipped rendering-relevant policy"
(`:246-249`) — true for `script-src`/`style-src`, but `connect-src` (the part
that governs where the app may open sockets/fetches) is exactly what differs, and
it is the highest-risk directive for a network tool.

## Why it matters

- A regression that widens the **production** `connect-src` (or any directive the
  test overlay masks) would pass the nightly CSP assertion, because the app under
  test never runs the production policy.
- The end-to-end harness is the only place the app boots under a real CSP; that
  boot deliberately uses the loosened one, so the one lane that could catch a CSP
  break is blind to `connect-src` drift.
- This compounds TIN-003: the mechanism that keeps the bridge's outbound socket
  from working in release (the strict production `connect-src`) is never
  regression-tested against.

## Evidence

- `tauri.test.conf.json:6` — test CSP with `ws://127.0.0.1:* ws://localhost:*`
  and `dangerousDisableAssetCspModification`.
- `system-integration.yml:250` — `pnpm tauri build --debug --config
  src-tauri/tauri.test.conf.json`.
- Failure-artifact dirs `tests_test_csp.py__…` exist, confirming the suite runs —
  but only under the overlay.

## Recommendation

- Add a **production-CSP boot check** that does not need the bridge: a lane (or a
  Rust/`tauri`-level assertion) that builds with the shipped config and verifies
  the app renders the terminal and reports **zero** CSP violations under the real
  `connect-src`. The bridge can't drive that build, so use a minimal
  render-and-quit probe plus a static assertion that the shipped
  `tauri.conf.json` `connect-src` contains no `ws://`/wildcard host.
- Track `tauri.test.conf.json` as a known stopgap: the real fix is a transport
  that does not require loosening `connect-src` for tests (e.g. keep the bridge
  purely in-process on the shipped CSP), after which the overlay — and this gap —
  can be deleted.
