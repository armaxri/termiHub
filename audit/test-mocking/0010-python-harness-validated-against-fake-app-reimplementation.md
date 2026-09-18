---
id: MOCK-010
title: The Python system harness is self-tested against fake_app.py, a hand-kept reimplementation of the TS bridge dispatcher (drift risk)
angle: test-mocking
severity: medium
category: test-gap
is_workaround: false
subsystem: tests/system (harness)
evidence:
  - tests/system/tests/fake_app.py:1
  - src/testbridge/dispatcher.ts
status: partial
resolution: "#3104 — ts-rs rollout PR-3: generated the 3 genuinely-dup'd event WIRE DTOs from Rust — RemoteDesktopClipboardEvent→RemoteDesktopClipboardPayload, RemoteDesktopCertPromptEvent (subject/issuer #[ts(optional)]), SshHostKeyPromptEvent. EXCLUDED (honest per-type): TerminalOutput/ExitEvent (events.ts is the DECODED camelCase/Uint8Array projection, NOT the snake_case+base64 wire DTO — real wire twins are private in services/events.ts, not a dup), TerminalResizeEvent (no Rust struct), RemoteDesktopFrame/CursorEvent (#[serde(flatten)] over core FrameUpdate/CursorUpdate — would drag core graphical cluster, deferred), RemoteDesktopStateEvent (core GraphicalState enum reconcile, deferred), PersistentSessionStateEvent (required-nullable vs optional-nullable mismatch), RemoteStateChange/LockedEventPayload (no TS twin). Remaining #3088: core graphical cluster + AGT-028 agent/core protocol DTOs"
---

## What
`tests/system/tests/fake_app.py` is a `FakeApp` that "plays the role the in-app bridge plays
in production — connect out, answer `{id, command}` envelopes … driven by a handler that
**mimics the TypeScript dispatcher's behavior**." The harness's own self-tests
(`test_protocol.py`, `test_runner_script.py`, `test_test_script.py`, etc.) drive this Python
fake rather than the real app.

So the bridge/transport/Driver machinery is validated end-to-end against a **second,
independent Python implementation of the same protocol** that a human keeps in sync with the
TypeScript `dispatcher.ts`. There is no shared source of truth (no generated protocol
schema) binding the two.

## Why it matters
- Green harness self-tests prove **harness ↔ fake_app agreement**, not **harness ↔ real app**
  agreement. If the real TS dispatcher changes a command name, envelope field, or error shape,
  the Python fake can be updated (or not) independently, and the self-tests stay green either
  way — the drift only surfaces on a full app-driven run, which is the dark integration lane
  (TBE-009 / TFE integration notes). A duplicated protocol double is exactly the "mocks
  hand-kept in sync with real types → silent drift" hazard, one layer up.
- This is a *reasonable* pattern for testing the harness plumbing without building the app, but
  it must be recognized as a fidelity boundary: the fake is a re-derivation, not a recording.

## Evidence
- `FakeApp` docstring stating it mimics the TS dispatcher: `tests/system/tests/fake_app.py:1-18`.
- Real dispatcher it must track: `src/testbridge/dispatcher.ts` (+ `TestBridge.tsx` deps).

## Recommendation
Bind both ends to one contract: define the bridge command/response envelopes in a single
schema (JSON Schema / generated types) that both `dispatcher.ts` and `fake_app.py` validate
against, and add a conformance test that fails when they diverge. At minimum, add a
periodically-run real-app smoke that drives one command of each shape through the actual
in-app bridge so a dispatcher change that the Python fake didn't mirror is caught somewhere
that gates merges, not only on the release-cadence lane.
