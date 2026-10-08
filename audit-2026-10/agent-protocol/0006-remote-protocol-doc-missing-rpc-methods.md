---
id: AGT2-006
title: "docs/remote-protocol.md omits 8 implemented RPC methods"
angle: agent-protocol
severity: low
category: docs
is_workaround: false
subsystem: "docs/remote-protocol.md vs core/src/protocol/methods.rs"
evidence:
  - core/src/protocol/methods.rs:63-64
  - core/src/protocol/methods.rs:73-77
  - core/src/protocol/methods.rs:104
  - core/src/protocol/methods.rs:149
  - agent/src/handler/dispatch.rs:1392
  - agent/src/handler/dispatch.rs:1414
  - agent/src/handler/dispatch.rs:2197
  - agent/src/handler/dispatch.rs:2610
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The agent registers several methods, and the desktop calls some of them, that the protocol spec never mentions: `agent.settingsUpdate`, `connection.types`, `session.getBuffer`, `tool.list`, `connection.files.mkdir`, `connection.files.set_permissions`, `connection.files.set_owner`, `connection.files.create_symlink` and `connection.files.copy`. The doc has sections for list/read/write/delete/rename/stat/read_range/write_range but not for the other file-mutation verbs. It also says nothing about `agent.settingsUpdate`, which changes agent runtime settings mid-session.

## Why it matters

The spec is the reference for compatibility work and for third-party or in-house agent implementations; this angle exists because of earlier drift (AGT-001/009/011). Undocumented mutating verbs such as chmod/chown/symlink and settingsUpdate are also missing from the security and threat-model discussion.

## Evidence

- `core/src/protocol/methods.rs:63-64`
- `core/src/protocol/methods.rs:73-77`
- `core/src/protocol/methods.rs:104`
- `core/src/protocol/methods.rs:149`
- `agent/src/handler/dispatch.rs:1392`
- `agent/src/handler/dispatch.rs:1414`
- `agent/src/handler/dispatch.rs:2197`
- `agent/src/handler/dispatch.rs:2610`

## Recommendation

Add a section for each missing method with its params, result, error codes and the protocol version that introduced it. Add a test that checks every `pub const` method name in core/src/protocol/methods.rs appears as a heading in docs/remote-protocol.md, so this cannot drift again.

## Verification

Confirmed. methods.rs defines AGENT_SETTINGS_UPDATE, CONNECTION_TYPES, SESSION_GET_BUFFER, TOOL_LIST and the files mkdir, set_permissions, set_owner, create_symlink and copy constants. docs/remote-protocol.md has no method section for any of them; the only mentions are `capabilities.connectionTypes` and the daemon-internal frame list (line 217), neither of which documents the desktop-facing RPC methods. Real documentation drift, low severity.
