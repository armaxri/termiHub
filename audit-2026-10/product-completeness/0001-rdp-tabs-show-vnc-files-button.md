---
id: PROD2-001
title: "RDP tabs show the VNC Files button and drop overlay, pointing to a File Transfer setting RDP does not have"
angle: product-completeness
severity: medium
category: bug
is_workaround: false
subsystem: "src/components/RemoteDesktop, src-tauri/src/session/graphical_manager"
evidence:
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:33
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:111
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:114
  - src/components/RemoteDesktop/fileTransfer.ts:92
  - src/components/RemoteDesktop/fileTransfer.ts:95
  - src/components/RemoteDesktop/fileTransfer.ts:101
  - core/src/connection/graphical_files.rs:106
  - core/src/connection/graphical_files.rs:123
  - src-tauri/src/session/graphical_manager.rs:490
  - core/src/backends/rdp_sidecar/config.rs:440
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The side-channel file transfer from #3770/#4191-#4194 is VNC-only: only the VNC schema has the `fileTransfer` group (core/src/backends/vnc/config.rs:599); rdp_sidecar/config.rs has no such field. RemoteDesktopTab is protocol-blind, though. It resolves the file channel for every graphical session (graphical_manager.rs:490 builds a FileChannelContext for any graphical type). For RDP, `FileChannelPolicy::from_settings` finds no `fileTransfer` key and returns `Disabled`. `filesButtonFor` then renders the toolbar Files button as `disabled` instead of `hidden`, with the tooltip "File transfer is off for this connection. Turn on File Transfer in the connection settings." Dragging OS files onto an RDP canvas shows the same "File transfer isn't available here" overlay, and a drop raises the same toast.

## Why it matters

RDP users are told to enable a setting that does not exist in their connection editor, and they see a dead Files control on every RDP tab. RDP does have file transfer (CLIPRDR clipboard files, #1765/#1778), so telling them file transfer is unavailable is also wrong and hides the path that actually works. Agent-hosted RDP has an agent route the backend could use, but there is no way to opt in. The concept documents only VNC as in scope.

## Evidence

- `src/components/RemoteDesktop/RemoteDesktopTab.tsx:33`
- `src/components/RemoteDesktop/RemoteDesktopTab.tsx:111`
- `src/components/RemoteDesktop/RemoteDesktopTab.tsx:114`
- `src/components/RemoteDesktop/fileTransfer.ts:92`
- `src/components/RemoteDesktop/fileTransfer.ts:95`
- `src/components/RemoteDesktop/fileTransfer.ts:101`
- `core/src/connection/graphical_files.rs:106`
- `core/src/connection/graphical_files.rs:123`
- `src-tauri/src/session/graphical_manager.rs:490`
- `core/src/backends/rdp_sidecar/config.rs:440`

## Recommendation

Gate the side-channel UI on the connection type. Either add a typed reason (e.g. FileChannelUnavailable::NotSupported) that the backend returns for non-VNC graphical types, with filesButtonFor mapping it to `hidden` and the drop handler and overlay showing nothing (or a hint about RDP's clipboard copy/paste for files), or expose a `fileSideChannel` capability on the connection type and check it in RemoteDesktopTab. Add an RDP case to RemoteDesktopTab.files.test.tsx. If RDP should get the agent route later, add the `fileTransfer` group to the RDP schema instead.

## Verification

Confirmed. Only core/src/backends/vnc/config.rs defines the `fileTransfer` key; the RDP config has only `clipboardFileTransfer`. graphical_manager.rs:490 builds a FileChannelContext for every graphical type. FileChannelPolicy::from_settings returns Disabled when the key is missing. filesButtonFor maps a non-viewOnly `unavailable` reason to `disabled`, with the unavailableCopy('disabled') hint telling the user to turn on File Transfer in the connection settings. RemoteDesktopTab has no protocol/type gating anywhere ('Protocol-blind'), and no RDP case exists in the tests. So every RDP tab shows a dead Files button whose tooltip points to a setting RDP does not have, and the drop overlay and toast are just as misleading.
