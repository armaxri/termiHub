---
id: I18N-009
title: Terminal connection-overlay hint routing keys off English error patterns
angle: i18n
severity: medium
category: bug
is_workaround: false
subsystem: src/components/Terminal/TerminalConnectionOverlay
evidence:
  - src/components/Terminal/TerminalConnectionOverlay.tsx:28
  - src/components/Terminal/TerminalConnectionOverlay.tsx:201
  - src/components/Terminal/TerminalConnectionOverlay.tsx:221
status: open
---

## What
The connection-failure overlay decides which curated remediation hint to show by
substring-matching the error against English literal patterns:

```ts
const SSH_AGENT_PATTERN = "Agent auth failed";
const TIMEOUT_PATTERN = "timed out";
const SERIAL_NOT_FOUND_PATTERNS = ["No such file", "cannot find", "not found"];
const SERIAL_PERMISSION_PATTERN = "Permission denied";
const SERIAL_BUSY_PATTERNS = ["busy", "in use", "Access is denied"];
...
const isAgentAuth = backendFamily === "ssh" && error.includes(SSH_AGENT_PATTERN);
const isTimeout = error.includes(TIMEOUT_PATTERN) && !isAgentAuth;
const isSerialPermission = isSerial && error.includes(SERIAL_PERMISSION_PATTERN);
```

It also splits the raw message on the literal em-dash separator `" — "`
(line 221) to strip the trailing remediation clause.

## Why it matters
Bucket A. These patterns match text that is partly termiHub's own English
constants and partly **localized OS/transport text** — the serial patterns
(`"in use"`, `"Access is denied"`, `"Permission denied"`) are the same localized
Windows/Unix strings flagged in I18N-007, and `"timed out"` can come from the OS.
Under a non-English locale the hint panels stop firing and the user loses the
tailored guidance (start ssh-agent, timeout advice, serial busy/permission fix).
The `" — "` split further assumes the backend always uses that exact English
separator format, coupling the UI to the Rust message layout.

## Evidence
`src/components/Terminal/TerminalConnectionOverlay.tsx:28-32` (pattern
constants), `:201-221` (matching + em-dash split).

## Recommendation
Drive the hint selection from a **structured error kind + backend family** pair
supplied by the backend, not from message text. The overlay already has
`backendFamily`; add the failure kind (`auth`/`timeout`/`not-found`/`permission`
/`busy`) as a typed field so the correct hint is chosen regardless of language,
and translate the hint copy via the catalog. This is the frontend twin of
I18N-007 and shares the structured-error remedy with I18N-001/002/008.
