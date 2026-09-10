---
id: TIN-015
title: ~100 manual test items remain, several release-gating, against a stated preference to automate/dismiss manual grades
angle: test-integration
severity: medium
category: test-gap
is_workaround: true
subsystem: tests/manual, docs/testing.md
evidence:
  - docs/testing.md:987
  - docs/testing.md:2745
  - tests/manual/
status: open
---

## What

`docs/testing.md` (§ Manual Testing / E2E Automation Coverage) states **~100
manual test items remain** across 14 `tests/manual/*.yaml` files, categorised as
visual rendering (~16), keyboard shortcuts (~8), OS-level behavior (~10), native
dialogs (~6), drag-and-drop (~7), external-app integration (~7), right-click (~5),
credential store (~3), platform SSH/agent (~5), and embedded services (~6).
Several are explicitly **release-gating and cannot be automated**:

- **X11/GUI-forwarding cross-platform release matrix** — "This is a **human
  release step — it cannot be run by CI or an AI agent**" (needs a real X server
  + native install dialogs) (~L2745).
- **Agent binary SHA-256 checksum release dry-run** (#1350) — release gate.
- macOS-native items (Finder Quick Actions #1369, Services provider #1409,
  XQuartz detect/install #1054, multi-window quit) — manual per ADR-5.

Deferred automation that is "verify manually until it lands":

- **FTP transfer queue** live byte-exact + kill/resume — "deferred to a
  follow-up; verify manually" (~L2949).
- **Monitoring auto-reconnect** (#1230) — "pending a fault-injection system test
  (follow-up), verify manually" (~L3008).
- **Live serial I/O** MT-SER-09 — manual, "no host socat echo fixture yet"
  (#859, ~L3099).

The project's stated preference (operating memory) is to automate or dismiss
manual grades and never hand over an unvalidated manual test.

## Why it matters

- Every release-gating manual item is a human bottleneck and a skip-under-pressure
  risk; for a ventilator-grade release, "a person must remember to run the X11
  matrix and eyeball glyph rendering on three OSes" is fragile.
- The deferred-automation items (FTP resume, monitoring reconnect, serial I/O)
  are real functional paths currently guarded only by prose.

## Evidence

- `docs/testing.md` §§ ~L987 (100 items + reason table), ~L2745 (X11 human
  release step), ~L2949 (FTP transfer deferred), ~L3008 (monitoring reconnect
  deferred), ~L3099 (serial I/O manual).
- `tests/manual/` — 14 YAML suites.

## Recommendation

- Triage the ~100 into (a) genuinely un-automatable visual/OS-native (keep as a
  tight, explicitly release-gating checklist), and (b) automatable-but-deferred —
  and land the named follow-ups: a host socat echo fixture for serial I/O (#859),
  a fault-injection lane for monitoring auto-reconnect (#1230), and the FTP
  transfer-queue live integration test (#1336).
- For the residual visual grades, extend the screenshot/marker approach
  (`test_visual_rendering_smoke.py`) to convert eyeball checks (glyphs, colours,
  box-drawing, white-flash) into automated marker assertions where feasible.
