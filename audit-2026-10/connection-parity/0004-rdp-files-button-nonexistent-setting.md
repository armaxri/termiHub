---
id: PARITY2-004
title: "RDP tabs show a disabled Files button and drop toast telling the user to enable a 'File Transfer' setting RDP does not have"
angle: connection-parity
severity: low
category: ux
is_workaround: false
subsystem: "src/components/RemoteDesktop + src-tauri/src/session/graphical_file_channel.rs"
evidence:
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:111
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:33
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:144
  - src/components/RemoteDesktop/fileTransfer.ts:92
  - src/components/RemoteDesktop/fileTransfer.ts:95
  - core/src/connection/graphical_files.rs:103
  - src-tauri/src/session/graphical_file_channel.rs:104
  - src-tauri/src/session/graphical_manager.rs:491
  - core/src/backends/vnc/config.rs:656
status: fixed
resolution: "#4348 — backend reports notOffered for types without a fileTransfer opt-in; RDP tabs hide the Files button, drop overlay and toast"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

RemoteDesktopTab is shared by VNC and RDP and always runs useRemoteDesktopFiles. The backend builds the file-channel policy from the settings keys fileTransfer and viewOnly (graphical_files.rs:103) for every graphical type. Only the VNC schema defines fileTransfer (vnc/config.rs:656); RDP's schema has driveRedirection, clipboardFileTransfer and pasteLocalFiles instead. So every RDP session, including agent-hosted RDP where the agent route could carry files, resolves to Unavailable{Disabled}. The toolbar then shows a disabled Files button (filesButtonFor) whose tooltip, and the toast on an OS file drop, say 'File transfer is off for this connection. Turn on File Transfer in the connection settings.' (fileTransfer.ts:95). There is no such setting in the RDP editor.

## Why it matters

RDP users are sent looking for a setting that does not exist, and files dropped on the RDP canvas do nothing except show that misleading hint. Neither RDP's real file paths (drive redirection or clipboard file paste) nor agent-route uploads are mentioned.

## Recommendation

Make the side channel type-aware. Either have the backend return a distinct reason (for example FileChannelUnavailable::NotOffered) when the type has no fileTransfer opt-in, and hide the Files button and drop overlay for it (or point to Drive Redirection / clipboard paste for RDP), or add the fileTransfer and fileTransferDir opt-in to the shared graphical field base so agent-hosted RDP can use the agent route like VNC. Pin whichever choice with an RDP case in RemoteDesktopTab.files.test.tsx.

## Verification

Confirmed. FileChannelPolicy::from_settings reads fileTransfer for every graphical type (graphical_files.rs:103-116), and graphical_manager builds a FileChannelContext for every session. Only the VNC schema defines fileTransfer; RDP has driveRedirection instead. As a result refusal() returns Disabled for every RDP session. filesButtonFor then shows a disabled button, and its tooltip, plus the toast on an OS file drop, read 'Turn on File Transfer in the connection settings' (fileTransfer.ts:92-95). RDP has no such setting. The type-blind RemoteDesktopTab does not gate on type anywhere. Low is right: the hint is misleading UX, nothing is broken.
