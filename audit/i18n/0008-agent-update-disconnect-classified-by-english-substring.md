---
id: I18N-008
title: Agent self-update "expected disconnect" detection uses English substrings
angle: i18n
severity: medium
category: bug
is_workaround: false
subsystem: src/components/AgentUpdateBanner
evidence:
  - src/components/AgentUpdateBanner/AgentUpdateBanner.tsx:22
status: open
---

## What
When the user applies a staged agent update, the transport is expected to drop as
the agent swaps its own binary. `isExpectedApplyDisconnect()` decides whether a
post-apply error is that expected drop (treated as **success**) or a real
failure, by lowercasing the error and substring-matching English words:

```ts
function isExpectedApplyDisconnect(error: unknown): boolean {
  const raw = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    raw.includes("disconnect") || raw.includes("connection") ||
    raw.includes("closed") || raw.includes("timeout") ||
    raw.includes("reset") || raw.includes("eof") ||
    raw.includes("not connected") || raw.includes("broken pipe")
  );
}
```

## Why it matters
Bucket A, with a correctness twist beyond translation. The word list is so broad
(`"connection"`, `"disconnect"`, `"closed"`) that it will match many **genuine**
failures whose message merely mentions a connection — so a real
update/restart failure can be reported to the user as success ("update applied").
Conversely, under a non-English transport/OS locale the SSH/transport error text
won't contain these English tokens, so a truly-expected disconnect is reported as
a hard failure. Either way the user gets the wrong outcome for a
binary-swap operation on the agent.

## Evidence
`src/components/AgentUpdateBanner/AgentUpdateBanner.tsx:22-34`.

## Recommendation
Base the decision on a **structured signal**, not message text: the update flow
knows it just requested an immediate apply, so an expected disconnect should be
identified by the transport-closed *event type* / error code from the IPC layer
(e.g. a `TransportClosed` kind), scoped to the short window after the apply
request — not by scanning the human-readable message. This shares the
structured-error remedy with I18N-001/002.
