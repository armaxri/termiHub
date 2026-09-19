---
id: FEC-009
title: ~37 `.catch(() => {})` sites swallow IPC failures on disconnect/close/cancel paths
angle: frontend-components
severity: medium
category: reliability
is_workaround: true
subsystem: src/components
evidence:
  - src/components/OpenConnections/OpenConnectionsModal.tsx:295
  - src/components/OpenConnections/OpenConnectionsModal.tsx:362
  - src/components/Terminal/Terminal.tsx:1051
  - src/components/Terminal/FileBrowserTab.tsx:73
  - src/hooks/useRemoteDesktopSession.ts:153
status: fixed
resolution: "#2732+#2751 — swallowed-error facet; remainder #2751"
---

## What
Around 37 sites in the component/service layer swallow a rejected IPC promise
with `.catch(() => {})` (or `.catch(() => undefined)`). They cluster on the
teardown/close/cancel paths: `closeTerminal(...).catch(() => {})`,
`cancelConnecting(...).catch(() => {})`, `detachPersistentTab(...).catch(() => {})`,
`remoteDesktopDisconnect(id).catch(() => {})`, `closeAgentSession(...).catch(() => {})`,
`xServerStop().catch(() => {})`, etc.

## Why it matters
On a safety-critical app the close/cancel paths are precisely where a swallowed
error hides a real leak: if `closeTerminal` or `remoteDesktopDisconnect` fails,
the backend session/PTY/graphical session keeps running while the UI shows it as
gone — a resource leak the user can neither see nor recover, and the "Open
Connections" panel exists specifically to hunt these. Blanket-swallowing also
hides genuine backend regressions from the LogViewer during development. Some of
these are defensible (best-effort cleanup during StrictMode churn), but an empty
handler makes "expected during teardown" indistinguishable from "the backend
just failed to release a session."

## Evidence
37 matches (grep, non-test). Highest-risk: session/agent teardown in
`OpenConnectionsModal.tsx:295,300,330,362,372,454,463,498`,
`Terminal.tsx:1051,1062`, `FileBrowserTab.tsx:73,99`,
`useRemoteDesktopSession.ts:153,206,303`.

## Recommendation
Replace bare swallows with `.catch((e) => frontendLog("<area>", ...))` at
minimum, so a failed release is visible in the LogViewer. For user-initiated
teardown (Open Connections "kill"), surface a recoverable `toast.error` when the
release actually fails — the user asked to close it, so a failure to close is
worth telling them. Reserve fully-silent catches for StrictMode-deferred cleanup
and comment why.
