---
id: TIN2-007
title: "docs/test-bridge.md command vocabulary omits the six projection* verbs and keeps a stale WebdriverIO example"
angle: test-integration
severity: info
category: "docs-drift"
is_workaround: false
subsystem: "docs/test-bridge.md"
evidence:
  - docs/test-bridge.md:214
  - docs/test-bridge.md:259
  - docs/test-bridge.md:796
  - src/testbridge/dispatcher.ts:1233
  - src/testbridge/dispatcher.ts:1285
  - tests/system/termihub_harness/bridge.py:722
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The 'Command vocabulary' table, which the 'Adding a command' guidance treats as the reference, lists 34 actions. It does not list projectionSubscribe, projectionDispatch, projectionState, projectionDropNext, projectionResync or projectionUnsubscribe. The dispatcher handles all six (dispatcher.ts:1233-1285) and Driver exposes them (bridge.py:722-785). test_bridge_protocol_contract.py checks the TS/Python/fake sides but not the doc. The 'Programmatic use' section also still shows a WebdriverIO `browser.execute` example, although the doc's own 'Not covered' section says the tauri-driver path was retired (#1027).

## Why it matters

The projection verbs are the most powerful bridge surface: they dispatch backend intents and drop or resync projection frames. Test authors and agents who read the documented vocabulary will not find them, or will reimplement them. The stale WebdriverIO snippet points authors at a path that no longer exists.

## Evidence

- `docs/test-bridge.md:214`
- `docs/test-bridge.md:259`
- `docs/test-bridge.md:796`
- `src/testbridge/dispatcher.ts:1233`
- `src/testbridge/dispatcher.ts:1285`
- `tests/system/termihub_harness/bridge.py:722`

## Recommendation

Add the six projection\* rows, with a short subsection or a link to the projection section of docs/testing.md / architecture.md. Replace the WebdriverIO snippet with the Python Driver equivalent. Optionally, extend test_bridge_protocol_contract.py to assert that every dispatcher action appears in the docs/test-bridge.md table.

## Verification

Confirmed. docs/test-bridge.md never mentions 'projection'. The dispatcher handles projectionSubscribe, projectionDispatch, projectionState and the other projection verbs (dispatcher.ts:1233 and following). docs/test-bridge.md:796-799 still shows a WebdriverIO browser.execute example, while line 897 says tauri-driver was retired (#1027). This is docs drift only.
