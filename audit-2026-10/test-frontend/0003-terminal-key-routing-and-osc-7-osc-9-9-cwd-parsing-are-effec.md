---
id: TFE2-003
title: "Terminal key routing and OSC 7 / OSC 9;9 cwd parsing are effect closures no test ever runs"
angle: test-frontend
severity: low
category: testability
is_workaround: false
subsystem: "src/components/Terminal/Terminal.tsx"
evidence:
  - src/components/Terminal/Terminal.tsx:1598-1655
  - src/components/Terminal/Terminal.tsx:1659-1676
  - src/components/Terminal/Terminal.tsx:1680-1688
  - src/test/mockXterm.ts:95
  - src/test/mockXterm.ts:106-107
  - src/components/Terminal/Terminal.xterm-integration.test.ts:134-144
status: fixed
resolution: "#4350 — key routing and OSC 7 / OSC 9;9 cwd parsing extracted to terminalInputRouting.ts with table-driven unit tests plus a mount wiring test"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The `attachCustomKeyEventHandler` callback (Terminal.tsx:1598-1655) decides which keystrokes reach the PTY. It handles view-mode Enter (show the reconnect prompt), shell-reserved passthrough, chord-pending blocking, copy/paste/select-all (paste calls preventDefault to avoid a double paste), the OSC-133-gated prompt-navigation fallthrough, and app-shortcut blocking. The OSC 7 handler (file:// URL decode, the `/C:/` Windows strip, ignoring malformed input) and the OSC 9;9 handler are written inline in the same effect. lcov shows all of these lines with 0 hits. MockXTerm stubs `attachCustomKeyEventHandler` and `registerOscHandler` as `vi.fn()` and no test calls the captured callbacks (only OSC 133 is pulled from mock.calls). The real-xterm integration test registers its own OSC 7 handler (line 134), not Terminal.tsx's.

## Why it matters

This is the keystroke path for every terminal. A reorder, such as running the app-shortcut check before passthrough or dropping preventDefault on paste, would swallow Ctrl-sequences the shell needs or reintroduce the double paste, with all tests green. OSC 7/9 data comes from the remote host and drives the file browser's cwd. Its parsing (decodeURIComponent, drive-letter strip) runs on untrusted input and is never exercised.

## Evidence

- `src/components/Terminal/Terminal.tsx:1598-1655`
- `src/components/Terminal/Terminal.tsx:1659-1676`
- `src/components/Terminal/Terminal.tsx:1680-1688`
- `src/test/mockXterm.ts:95`
- `src/test/mockXterm.ts:106-107`
- `src/components/Terminal/Terminal.xterm-integration.test.ts:134-144`

## Recommendation

Extract `routeTerminalKeyEvent(e, ctx): boolean` (ctx = sessionId/viewMode/passthrough setting/chord state/hasMarks plus callbacks) and pure `parseOsc7Cwd(data): string | null` and `parseOsc9Cwd(data): string | null` into a sibling module. Unit-test them with a table of cases, including malformed URIs, `%`-escapes, `/C:/` and non-file protocols. Keep one Terminal mount test that grabs the handler from `attachCustomKeyEventHandler.mock.calls[0][0]` and asserts that paste calls preventDefault and returns false.

## Verification

Partly overstated. Terminal.command-marks.test.tsx does grab the handler from `attachCustomKeyEventHandler.mock.calls[0][0]` and runs it, covering the OSC-133 prompt-navigation fallthrough and the app-shortcut block (lines 156-227). So it is wrong that no test ever runs it. Still untested: view-mode Enter, shell-reserved passthrough, chord-pending, copy, paste with preventDefault, and select-all. The OSC 7 and OSC 9;9 handlers are never invoked by any test: no test pulls ident 7 or 9 from the mock, and setTabCwd appears only in store tests. The gap is real but narrower than claimed. OSC parsing is wrapped in try/catch and only sets a cwd string, so low.
