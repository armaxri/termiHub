---
id: UX2-005
title: "macOS Cmd+Q / menu Quit appears to skip the detach-vs-terminate prompt and end every live session"
angle: ux-flows
severity: medium
category: destructive-action-guard
is_workaround: false
subsystem: "src-tauri/src/lib.rs (RunEvent)"
evidence:
  - src-tauri/src/lib.rs:1076-1091
  - src-tauri/src/window/mod.rs:148-157
  - src/App.tsx:265-288
  - docs/testing.md:2439
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The only live-session and data-loss guard on shutdown is the frontend `onCloseRequested` interceptor (App.tsx), which raises the detach-vs-terminate dialog. On macOS, an explicit quit (app-menu Quit / Cmd+Q, `code == Some`) is handled in the Rust `ExitRequested` branch. That branch runs `run_app_teardown` and lets the exit proceed. Nothing is emitted to the webviews, and windows are not given a CloseRequested, so the frontend prompt appears never to run. As far as the code shows, Cmd+Q, the standard macOS way to quit, ends all non-persistent sessions (and unsaved editors) at once, while closing the window the same app is in does prompt. The only coverage is the manual MT-WIN-02, which checks only that Cmd+Q quits. Not live-verified, since this machine cannot run live E2E.

## Why it matters

On macOS most users quit with Cmd+Q, not by closing windows. The guard built for #1903 protects the less common gesture and skips the common one. A mis-hit Cmd+Q (next to Cmd+W) kills remote work with no prompt.

## Evidence

- `src-tauri/src/lib.rs:1076-1091`
- `src-tauri/src/window/mod.rs:148-157`
- `src/App.tsx:265-288`
- `docs/testing.md:2439`

## Recommendation

In the macOS explicit-quit branch, call `api.prevent_exit()` on the first request and emit an `app-quit-requested` event. Have the frontend run the same classification as `prepareWindowClose` across all windows. When nothing would be lost, or after the user confirms, call a `confirm_quit` command that sets a flag and calls `app.exit(0)` again, which then proceeds. Extend MT-WIN-02 to cover "Cmd+Q with a live non-persistent tab prompts".

## Verification

Likely real, but this is inferred from the code and not live-verified. The ExitRequested handler (lib.rs:1083-1091) either prevents exit (code None) or, for an explicit quit on macOS, runs run_app_teardown and proceeds. It emits no event to the webviews. The only prompt is the frontend onCloseRequested in App.tsx. The codebase has no custom menu or quit interception, so the default Quit item never reaches the detach-vs-terminate dialog. Tao's handling of NSApp terminate could not be confirmed without a live run, but nothing in the code routes Cmd+Q through the frontend guard.
