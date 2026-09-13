---
id: SM-005
title: Lifecycle machine has no auth-failed or host-key-prompt state — both collapse into Connecting/Failed
angle: state-machine-ux
severity: high
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/session_projection/store.rs + src/types/sshHostKey.ts
evidence:
  - src-tauri/src/session_projection/store.rs:49
  - src-tauri/src/session_projection/store.rs:310
  - src/types/sshHostKey.ts:1
  - src/utils/reconnectBackoff.ts:51
status: open
---

## What
The coarse session lifecycle enum (`store.rs:49-73`) models only
`Connecting | Connected | Disconnected | Reconnecting | Failed | SessionLost`. It has:
- **No `auth-failed` state** — an authentication failure collapses into `Failed` with a
  free-text `error` string (`store.rs:310`). The UI cannot branch on it.
- **No `host-key-prompt` state** — host-key verification runs out-of-band
  (`src/types/sshHostKey.ts` flow); a connect blocked awaiting a host-key decision is just
  `Connecting`, indistinguishable from a slow TCP connect.
- **No `degraded`/`stale`** state for a flaky-but-alive link (only the unrelated
  `MonitorStatus` union has `stale`).

## Why it matters
- **Auth failure loops pointlessly.** Because auth failure is an opaque `Failed`, a resilient
  tab's backoff loop (`reconnectBackoff.ts:51-57`) re-attempts with the same rejected
  credentials up to the retry cap, each attempt failing identically, instead of stopping and
  offering "re-enter password". The user waits through doomed retries with no credential-
  refresh affordance.
- **Host-key prompts can be aborted by the connect deadline.** A `Connecting` tab awaiting a
  host-key modal is subject to the ~90s connect deadline (see SM-004), which can fire while
  the user is still reading the prompt, killing a connect that was waiting on a human
  decision.
- Ambiguous status: the user cannot tell "wrong password" from "host unreachable" from
  "waiting for you to accept a host key" — all render as generic Connecting/Failed.

## Evidence
- `store.rs:49-73` — enum lacks auth-failed / host-key-prompt / degraded.
- `store.rs:310` — `connectFailed` folds a generic `Failed(Error)` with a string.
- `src/types/sshHostKey.ts` — host-key decision handled as a separate prompt flow not
  reflected in the lifecycle state.

## Recommendation
Add first-class `AuthFailed` (terminal, offers credential re-entry rather than blind retry)
and `HostKeyPrompt` (a blocking sub-state exempt from the connect deadline) states, and treat
auth failure as non-retryable-without-new-credentials in the backoff reducer. Consider a
`Degraded` state for alive-but-flaky links so the status is legible rather than flapping
Connected/Reconnecting.
