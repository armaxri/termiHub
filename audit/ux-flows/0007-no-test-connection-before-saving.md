---
id: UX-007
title: No "Test Connection" — the only way to validate is Save & Connect (persists first)
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/ConnectionEditor
evidence:
  - src/components/ConnectionEditor/ConnectionEditor.tsx:902
  - src/components/ConnectionEditor/ConnectionEditor.tsx:937
status: open
---

## What
There is no "Test Connection" affordance anywhere in the connection editor (grep for
`testConnection`/`test-connection` returns only unrelated fixture strings). The only way to verify
reachability/credentials is **Save & Connect** (`ConnectionEditor.tsx:902`), which persists the
connection record first (`saveConnection()` at `:937`) and opens a terminal tab. A user cannot
probe a host/key/credential without committing a saved record.

## Why it matters
A typo in host, port, key path, or credentials is only discovered *after* the connection is saved,
as a "Connection failed" overlay. There is no low-commitment "does this work?" step, which is a
standard expectation in connection managers and reduces trial-and-error friction, especially for
first-time setup of jump hosts, key auth, and non-default ports.

## Evidence
- No `testConnection` handler in `src/`.
- `ConnectionEditor.tsx:902,937` — Save & Connect persists then opens a tab; this is the only
  validation path.

## Recommendation
Add a "Test Connection" button that runs a transient connect (reusing the existing pre-connect
validation path in `useConnectSavedConnection`) without persisting the record, reporting success or
a specific failure inline. This also gives the create flow a feedback loop it currently lacks.
