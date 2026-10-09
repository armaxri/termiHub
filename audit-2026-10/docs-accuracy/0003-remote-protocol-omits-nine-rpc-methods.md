---
id: DOC2-003
title: "remote-protocol.md omits nine RPC methods the agent registers and the desktop calls"
angle: docs-accuracy
severity: medium
category: incomplete-spec
is_workaround: false
subsystem: "docs/remote-protocol.md"
status: fixed
resolution: "#4325 — documented connection.types, session.getBuffer, agent.settingsUpdate, connection.files.mkdir/set_permissions/set_owner/create_symlink/copy, tool.list and tool.run (plus the agent.update_available notification) in docs/remote-protocol.md; protocol_doc_tests checks every dispatcher method and notification has a heading"
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - core/src/protocol/methods.rs:63-64
  - core/src/protocol/methods.rs:73-77
  - core/src/protocol/methods.rs:104
  - core/src/protocol/methods.rs:149
  - src-tauri/src/session/remote_proxy.rs:683
  - src-tauri/src/session/remote_proxy.rs:1046-1087
  - src-tauri/src/session/persistent_controller.rs:496
  - src-tauri/src/terminal/agent_manager.rs:2913
  - docs/remote-protocol.md:1892
---

## What

The protocol spec (version 0.26.0) documents most methods under ### headings. It does not mention `connection.types`, `session.getBuffer`, `connection.files.mkdir`, `connection.files.set_permissions`, `connection.files.set_owner`, `connection.files.create_symlink`, `connection.files.copy`, `agent.settingsUpdate` or `tool.list` anywhere. All nine are registered by the agent dispatcher and all except tool.list are called by the desktop (remote_proxy.rs:683 and 1046-1087, persistent_controller.rs:496, agent_manager.rs:2913). The file-op methods are also used by the VNC agent file-transfer path (graphical_browse.rs:241-300).

## Why it matters

The spec claims to be the desktop-to-agent contract and is the reference for compatibility decisions such as the version matrix and the 'MUST reject' rules. Methods missing from it have no documented params, errors or version-introduced notes, which makes compatibility reviews and third-party agent work unreliable.

## Recommendation

Add a ### section for each of the nine methods (params, result, error codes, version introduced) next to the existing `connection.files.*` and `tool.*` sections. Consider a unit test that checks every `pub const` method name in core/src/protocol/methods.rs appears as a heading in docs/remote-protocol.md.

## Verification

Confirmed. Grepping remote-protocol.md finds 0 hits for 8 of the 9 method names. connection.types appears only as the capabilities.connectionTypes field, never as a method. All 9 are pub consts in core/src/protocol/methods.rs.
