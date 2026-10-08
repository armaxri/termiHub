---
id: PROD2-004
title: "Deleting an SSH connection that a VNC connection uses as its linked file route gives no warning"
angle: product-completeness
severity: low
category: ux
is_workaround: false
subsystem: "src/components/Sidebar (connection delete), VNC linked SSH route"
evidence:
  - src/components/Sidebar/ConnectionList.tsx:982
  - src/components/Sidebar/ConnectionList.tsx:987
  - src/utils/jumpHost.ts:181
  - src-tauri/src/session/graphical_linked_ssh.rs:58
  - README.md:277
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The delete confirmation adds a dependents warning only for jump-host references (`findJumpHostDependents`, which checks only `getJumpHosts(c.config)`). A VNC connection that names the SSH connection in `fileTransferVia` (#4194) is not counted, so deleting that SSH connection gives no notice. The VNC link then resolves to `LinkedLookup::Missing` and file transfer quietly becomes "no route". README.md:277 documents that outcome, but the user is never told at delete time. Rename and move references are rewritten correctly (follow_file_route_ref), so deletion is the only gap.

## Why it matters

The user finds out only in a later VNC session, when drop-to-upload refuses with the generic "VNC has no portable file transfer…" hint, which does not say the linked connection was deleted. The jump-host case already set the expectation that deleting a referenced connection is flagged (#941).

## Evidence

- `src/components/Sidebar/ConnectionList.tsx:982`
- `src/components/Sidebar/ConnectionList.tsx:987`
- `src/utils/jumpHost.ts:181`
- `src-tauri/src/session/graphical_linked_ssh.rs:58`
- `README.md:277`

## Recommendation

Extend the dependents check, or add a sibling `findFileRouteDependents`, to include connections whose `config.settings.fileTransferVia` is in targetIds. Append "…used as the file-transfer route by N VNC connection(s): …" to the delete message. Optionally, have the backend's no-route refusal name a dangling `fileTransferVia` ("the linked SSH connection no longer exists — pick another under File Transfer") instead of the generic noRoute copy.

## Verification

Confirmed. ConnectionList.tsx builds the delete warning only from findJumpHostDependents, which in jumpHost.ts checks only getJumpHosts(c.config) proxyJump hops. No frontend code outside the editor and schemaDefaults/agentGraphicalTunnel references `fileTransferVia` for delete dependents. README.md:277 documents that deleting the SSH connection makes file transfer unavailable, so the behaviour is known, but the user gets no warning when deleting. Impact is minor: file transfer degrades, nothing breaks, and the user can pick another connection.
