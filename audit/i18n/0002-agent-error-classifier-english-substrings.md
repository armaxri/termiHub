---
id: I18N-002
title: Agent connection-error classifier keys entirely off English substrings
angle: i18n
severity: high
category: bug
is_workaround: false
subsystem: src/utils/classifyAgentError
evidence:
  - src/utils/classifyAgentError.ts:25
  - src/utils/classifyAgentError.ts:35
  - src/utils/classifyAgentError.ts:46
  - src/utils/classifyAgentError.ts:59
  - src/utils/classifyAgentError.ts:69
status: open
---

## What
`classifyAgentError()` maps a raw backend error into a user-facing category
(`unreachable` / `auth-failure` / `agent-missing` / `agent-outdated` /
`already-connected`) purely by `raw.includes("...")` against English phrases:

- `"Connection failed"` → unreachable
- `"auth failed"` / `"Authentication failed"` → auth-failure
- `"Exec failed"` / `"Read initialize response"` / `"Write initialize failed"` → agent-missing
- `"Initialize rejected"` / `"Unsupported protocol version"` → agent-outdated
- `"is already connected"` → already-connected

Anything that does not match falls through to a generic "Connection Failed" that
just dumps the raw string.

## Why it matters
Bucket A. The whole point of this classifier is to give the user actionable,
distinct remediation ("Agent Not Installed" vs "Authentication Failed" vs
"Agent Version Incompatible"). That routing is only correct while every layer
that produces these strings — libssh2, OpenSSH, the OS, and termiHub's own Rust
error formatting — emits exactly these English fragments.

- Under a non-English SSH/OS locale, or after any wording change in the Rust
  layer, matches silently stop firing and **every** failure collapses to the
  generic fallback — the user loses the tailored guidance that tells them
  whether to deploy the agent, fix credentials, or update.
- `"Exec failed"` / connection phrases can also come from the remote shell, so
  a localized remote can misroute an auth failure to "Agent Not Installed" and
  send the user down the wrong remediation path.

This is fragile even in the English build (it couples the UI to exact phrasing
in three different Rust/agent files) and outright broken the moment any of those
strings is localized.

## Evidence
`src/utils/classifyAgentError.ts:22-85` — the entire function body is a ladder
of `raw.includes("<English phrase>")`. No structured error code participates.

## Recommendation
Carry a **structured category** from the backend. The agent/SSH connect path
already knows which failure occurred; surface it as a stable `code`/`kind` field
on the error payload and switch on that. Keep `classifyAgentError` only as a
last-resort fallback for truly unstructured errors, and translate the resulting
`title`/`message` via the message catalog (see I18N-020) rather than hardcoding
them. Same structured-error fix resolves I18N-001, I18N-003, and I18N-004.
