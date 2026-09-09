---
id: WA-FE-010
title: initialCommand sent via arbitrary 200ms setTimeout after connect (shell-readiness race)
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: components/Terminal
evidence:
  - src/components/Terminal/Terminal.tsx:1019
  - src/components/Terminal/Terminal.tsx:1020
status: open
---

## What
When a workspace-launched tab carries an `initialCommand`, it is written to the PTY 200ms after
the session connects, via a bare `setTimeout`:

```ts
// Send initial command after session connects (used by workspace launch)
if (initialCommand && !initialSessionIdRef.current) {
  setTimeout(() => { sendInput(sessionId, initialCommand + "\n"); }, 200);
}
```

## Why it matters
- 200ms is a guess at how long the remote shell takes to become ready to accept input. On a slow
  SSH/serial link or a busy host the shell prompt may not be up yet, so the command is typed into a
  not-yet-ready shell (lost, or interleaved with the login banner). On a fast local shell 200ms is
  pure latency the user waits for their launch command.
- There is no readiness signal driving it — it is a fixed delay papering over the absence of a
  "shell ready" event.

## Evidence
`src/components/Terminal/Terminal.tsx:1018-1023`.

## Recommendation
Drive the initial command off an actual readiness signal — send it once the first output/prompt
is observed, or expose a backend "shell ready" event and gate on it — rather than a fixed 200ms.
If a heuristic must remain, at least send on first-output-received with the timeout only as a
ceiling. Removing the magic `200` delay is the signal.
