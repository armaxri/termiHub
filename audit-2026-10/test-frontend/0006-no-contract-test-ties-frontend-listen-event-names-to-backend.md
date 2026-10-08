---
id: TFE2-006
title: "No contract test ties frontend listen() event names to backend emit names; most event-wrapper callbacks never run"
angle: test-frontend
severity: low
category: test-gap
is_workaround: false
subsystem: "src/services/events.ts"
evidence:
  - src/services/events.ts:151-157
  - src/services/events.ts:164-174
  - src/services/events.ts:776-781
  - src/services/wireContract.test.ts:1-23
  - src-tauri/src/terminal/xserver/types.rs:427
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

wireContract.test.ts pins invoke() response shapes against Rust golden fixtures, but nothing checks the event-channel names. events.ts hard-codes about 40 string literals ("ssh-host-key-prompt", "ssh-keyboard-interactive-prompt", "x-server-consent-needed", ...) that must match Rust `emit` strings or constants. In the lcov, the callback-forwarding line of many wrappers has 0 hits (events.ts:100-141, 155, 170, 186, 199, 552, 565, 622, 686, 695, 710, 723, 749, 765, 780). A grep today shows every name has a Rust counterpart, apart from the deliberately retained `remote-state-change`.

## Why it matters

Renaming an event on either side compiles and passes every test, but the listener goes dead. For the SSH host-key or keyboard-interactive prompt, or the X-server consent request, that means the dialog never appears and the connect hangs or times out. The team already chose golden-fixture contracts for invoke; events are the remaining unpinned IPC edge.

## Evidence

- `src/services/events.ts:151-157`
- `src/services/events.ts:164-174`
- `src/services/events.ts:776-781`
- `src/services/wireContract.test.ts:1-23`
- `src-tauri/src/terminal/xserver/types.rs:427`

## Recommendation

Have the existing Rust `ipc_wire_fixtures` test write an `events.json` fixture listing every emitted event-name constant. Add a vitest that imports it and asserts each name events.ts subscribes to is in that list. Export the names from events.ts as constants so the test can enumerate them. Optionally add a table-driven test that fires each wrapper through the mocked `listen` and asserts the payload is forwarded.

## Verification

Confirmed. wireContract.test.ts pins only invoke response payload shapes, not event names. events.ts hard-codes about 38 listen() string literals, for example `ssh-host-key-prompt` at line 154, which matches the literal emit in src-tauri/src/session/ssh_host_key_verifier.rs:70. Nothing cross-checks the names, and events.test.ts covers only a few wrappers (terminal-output/exit, vscode-edit-complete, log-entry). All names currently match, so this is a latent regression risk. Low.
