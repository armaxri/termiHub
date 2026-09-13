---
id: WA-FE-003
title: Systemic "config.config as unknown as Record<string, unknown>" type-erasure casts
angle: workaround-frontend
severity: medium
category: workaround
is_workaround: true
subsystem: store / utils / components (connection config)
evidence:
  - src/store/appStore.ts:413
  - src/utils/featureFlags.ts:19
  - src/utils/connectionSearch.ts:22
  - src/hooks/useConnectSavedConnection.ts:51
  - src/components/Sidebar/ConnectionList.tsx:559
  - src/components/Sidebar/ConnectionList.tsx:1015
  - src/components/ConnectionEditor/ConnectionEditor.tsx:281
  - src/components/ConnectionEditor/ConnectionEditor.tsx:738
  - src/store/appStore.ts:5184
  - src/store/appStore.ts:5192
  - src/components/TunnelEditor/tunnelValidation.ts:35
status: open
---

## What
The schema-driven connection config (`connection.config.config`) is untyped at consumer
sites, so ~11 production locations launder it through `unknown` to poke at fields:

```ts
const cfg = connection.config.config as unknown as Record<string, unknown>;
...
if (typeof cfg["host"] === "string") ...
```

`as unknown as` is the double-cast that defeats TypeScript's structural checking entirely —
it is functionally the same escape hatch as `any`, which the repo's own coding standard bans
("No `any` types"). Every one of these sites then reads string-keyed fields (`host`,
per-connection feature flags, etc.) with no compile-time guarantee the key exists or has the
expected type.

## Why it matters
- A typo in a key (`"hsot"`), a renamed schema field, or a type change (string → number) is
  invisible to the compiler at all of these sites — the failure surfaces at runtime as a
  missing host, a silently-off feature, or `undefined` behavior.
- It is a repeated pattern (not one-off), which means the real type is missing at the source,
  and each new consumer copies the cast — the workaround is spreading.

## Evidence
See the file:line list above. The recurring shape is
`connection.config.config as unknown as Record<string, unknown>` (appStore.ts:413,
featureFlags.ts:19, connectionSearch.ts:22, useConnectSavedConnection.ts:51,
ConnectionList.tsx:559/1015, appStore.ts:5184/5192) plus the editor variants casting into
`Record<string, unknown>` / `RemoteAgentConfig` (ConnectionEditor.tsx:281/738) and the tunnel
variant (tunnelValidation.ts:35).

## Recommendation
Give `config.config` a real type. Since connection types are schema-driven, generate or hand-write
a discriminated union keyed on connection `type` (SSH/Docker/serial/agent/…), or at least typed
accessor helpers (`getConfigString(config, "host")`) that centralize the one unavoidable cast and
validate the key/type once. Replace the scattered `as unknown as` sites with the typed accessor.
Zero `as unknown as` on `config.config` is the signal it is fixed.
