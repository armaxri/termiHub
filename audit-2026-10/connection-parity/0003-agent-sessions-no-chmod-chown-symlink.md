---
id: PARITY2-003
title: "Agent-hosted sessions never offer chmod/chown/symlink, although the agent RPC and RemoteFileBrowserProxy fully support them"
angle: connection-parity
severity: medium
category: missing-feature
is_workaround: false
subsystem: "src/hooks/useSessionFileSystem.ts + src-tauri/src/session/file_ops.rs"
evidence:
  - src/hooks/useSessionFileSystem.ts:517
  - src/hooks/useSessionFileSystem.ts:518
  - src/hooks/useSessionFileSystem.ts:519
  - src-tauri/src/session/file_ops.rs:472
  - src-tauri/src/session/file_ops.rs:476
  - src-tauri/src/session/remote_proxy.rs:1053
  - src-tauri/src/session/remote_proxy.rs:1062
  - src-tauri/src/session/remote_proxy.rs:1076
  - agent/src/handler/dispatch.rs:1988
  - agent/src/handler/dispatch.rs:2011
  - agent/src/handler/dispatch.rs:2036
  - src-tauri/src/session/file_ops.rs:182
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The file-browser UI offers permission, owner and symlink actions only when sftpCapable is true (useSessionFileSystem.ts:517-519). That flag comes from session_has_exec_capability, which resolves only when the session downcasts to an SftpFileBrowser (file_ops.rs:476), so it always fails for an agent-hosted session (a RemoteProxy). Yet the whole chain below the UI works: session_set_permissions goes through the generic browser (file_ops.rs:182), RemoteFileBrowserProxy forwards connection.files.set_permissions, set_owner and create_symlink (remote_proxy.rs:1053/1062/1076), and the agent dispatches all three (dispatch.rs:1988/2011/2036) to the hosted SSH (SFTP) or local backend. The code comment calling remote-agent sessions 'byte-based' with no chmod support is out of date.

## Why it matters

The same saved SSH connection loses chmod, chown and create-symlink in the file browser when it runs through an agent, even though the backend path is built and tested end to end. This is the kind of silent direct-versus-agent capability gap that PARITY-003 was meant to remove.

## Recommendation

Gate these actions on a real capability instead of sftpCapable. Either add a session_file_capabilities command that reports, per session, which advanced ops the browser supports (for a RemoteProxy, ask the agent or use the hosted type's capabilities, true for ssh and unix local), or offer the actions for agent sessions and show NotSupported as a normal error toast. Keep VS Code open and the SFTP-to-SFTP stream on sftpCapable.

## Verification

Confirmed. supportsPermissions, supportsOwner and supportsSymlink are all tied to sftpCapable (useSessionFileSystem.ts:517-519). sftpCapable comes from has_exec_capability, which goes through sftp_browser() and its SftpFileBrowser downcast (file_ops.rs:264-280), so it fails for a RemoteProxy browser. The layers below the UI do support these operations for agent sessions: the generic session set_permissions uses resolve() (file_ops.rs:182), RemoteFileBrowserProxy forwards set_permissions, set_owner and create_symlink over RPC (remote_proxy.rs:1053-1082), and the agent registers handlers for all three (dispatch.rs:1988/2011/2036). No audit note or ADR records this gap as a deliberate decision. It is a real gap between direct and agent-hosted sessions.
