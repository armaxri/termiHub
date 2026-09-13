---
id: FEC-003
title: Initial command is sent on a fixed 200ms setTimeout after connect
angle: frontend-components
severity: medium
category: workaround
is_workaround: true
subsystem: src/components/Terminal
evidence:
  - src/components/Terminal/Terminal.tsx:1019
status: open
---

## What
After a workspace-launch session connects, the initial command is injected with
a hardcoded `setTimeout(() => sendInput(sessionId, initialCommand + "\n"), 200)`.

## Why it matters
200 ms is a guess at "the shell has printed its first prompt and is ready for
input." On a slow remote/agent shell the command is sent before the shell is
ready and is lost or mangled; on a fast local shell 200 ms is pure latency
before the command runs. There is no correctness signal tying the send to shell
readiness, and the timer is not cleared on teardown, so a tab closed within
200 ms of connecting still fires `sendInput` into a session that is being torn
down.

## Evidence
`src/components/Terminal/Terminal.tsx:1019-1023`
```ts
if (initialCommand && !initialSessionIdRef.current) {
  setTimeout(() => {
    sendInput(sessionId, initialCommand + "\n");
  }, 200);
}
```

## Recommendation
Gate the initial command on a real readiness signal — e.g. the first
`connection.output` chunk for the session (shell prompt emitted), or an OSC
shell-integration "prompt start" marker where available — rather than a fixed
delay. At minimum, track the timer id and clear it in the effect cleanup so a
fast tab-close cannot send into a dead session.
