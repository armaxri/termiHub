---
id: FEC-008
title: ConnectionConfig.config is untyped, forcing ~25 `as (unknown as) Record<string,unknown>` casts across the frontend
angle: frontend-components
severity: medium
category: arch
is_workaround: false
subsystem: src/types
evidence:
  - src/types/connection.ts
  - src/components/ConnectionEditor/ConnectionEditor.tsx:281
  - src/components/ConnectionEditor/ConnectionEditor.tsx:738
  - src/hooks/useRemoteDesktopSession.ts:120
  - src/utils/featureFlags.ts:19
status: open
---

## What
`ConnectionConfig.config` (the per-connection-type settings blob) is effectively
untyped, so every read of a concrete field goes through a cast. There are ~25
`connection.config.config as …` sites across `src/`, most of the form
`config.config as unknown as Record<string, unknown>` (a double cast — the
`unknown` step exists only to silence the compiler because the source type does
not overlap the target). Two representative spots use even weaker casts:
`existingAgent.config as unknown as Record<string, unknown>`
(`ConnectionEditor.tsx:281`) and `connSettings as unknown as RemoteAgentConfig`
(`ConnectionEditor.tsx:738`), where an arbitrary settings bag is asserted to be a
fully-typed agent config with no validation.

## Why it matters
Every `as unknown as` is a hole in the type system on data that crosses the
IPC/store boundary — exactly where the compiler's help is most valuable. A
renamed or missing config field (e.g. `host`, `scaleMode`, `viewOnly`) produces
`undefined` at runtime with zero compile-time signal, and the pattern is
copy-pasted widely enough (25 sites) that it reads as the sanctioned way to
access config, entrenching the unsoundness. `CLAUDE.md` explicitly bans `any`;
`as unknown as` is the same escape hatch wearing a coat.

## Evidence
25 `config.config as …` occurrences (grep). Double casts at
`src/components/Sidebar/ConnectionList.tsx:559,1015`,
`src/utils/connectionSearch.ts:22`, `src/utils/featureFlags.ts:19`,
`src/hooks/useConnectSavedConnection.ts:51`,
`src/components/ConnectionEditor/ConnectionEditor.tsx:281,738`, etc.

## Recommendation
Make `ConnectionConfig` a discriminated union over `type` with a typed `config`
per connection kind (the connection-type schemas already describe these fields),
or at minimum type `config` as `Record<string, unknown>` at the source so reads
need only a single, checked narrowing (ideally via a zod parse) instead of
`as unknown as`. Replace the agent-config assertion with a validated parse.
