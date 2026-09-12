---
id: SM-026
title: Window claim() silently supersedes the prior session owner; the loser loses resize rights with no signal
angle: state-machine-ux
severity: low
category: bug
is_workaround: false
subsystem: src-tauri/src/window/mod.rs
evidence:
  - src-tauri/src/window/mod.rs:175
  - src-tauri/src/window/mod.rs:235
status: open
---

## What
In the multi-window ownership map, `claim()` inserts unconditionally (`window/mod.rs:175-178`),
overwriting the previous owner of a `sessionId` without notifying it. `may_resize` (`:235`)
then denies the ex-owner. The transition is structurally correct (it prevents double-
ownership) but is entirely silent.

## Why it matters
If two windows ever render the same `sessionId` (a handoff race, or a restore/workspace that
references one session in two window slices), the losing window silently cannot resize its
terminal — the PTY is sized by the other window — with **no indication why**. An ambiguous,
unexplained "my terminal won't resize" state.

## Evidence
- `window/mod.rs:175-178` — `claim()` inserts unconditionally, prior owner not notified.
- `window/mod.rs:235` — `may_resize` denies the superseded owner.

## Recommendation
Emit an ownership-changed signal to the superseded window (or surface a small "controlled by
another window" badge) so the resize denial is explained rather than silent.
