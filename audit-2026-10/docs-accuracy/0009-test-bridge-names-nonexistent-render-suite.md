---
id: DOC2-009
title: "test-bridge.md names a non-existent render-path test suite"
angle: docs-accuracy
severity: low
category: stale-reference
is_workaround: false
subsystem: "docs/test-bridge.md"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - docs/test-bridge.md:388
  - tests/system/tests/test_terminal_render_paths.py
---

## What

test-bridge.md:388 says the measure_terminal / lose_terminal_webgl_context suite is `tests/system/tests/test_xterm_render_paths.py`. That file does not exist; the suite is `tests/system/tests/test_terminal_render_paths.py`.

## Why it matters

Minor, but it is the one pointer test authors follow from the bridge API doc to an example.

## Recommendation

Change the path to tests/system/tests/test_terminal_render_paths.py.

## Verification

Confirmed. test-bridge.md cites test_xterm_render_paths.py, which does not exist. The suite is tests/system/tests/test_terminal_render_paths.py.
