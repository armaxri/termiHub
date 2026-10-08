---
id: UX2-007
title: "Dropping files on a VNC session whose linked SSH route needs a password silently discards the drop on cancel or failure"
angle: ux-flows
severity: low
category: feedback-gap
is_workaround: false
subsystem: "src/components/RemoteDesktop"
evidence:
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:122-128
  - src/hooks/useRemoteDesktopFiles.ts:43
  - src/hooks/useRemoteDesktopFiles.ts:108-131
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

New in #4271. When the linked SSH file route is waiting for a secret, a drop calls `remoteFiles.refresh()`, which prompts for the password. The upload continues only if the result is "ready". If the user cancels the prompt, the secret is rejected `MAX_SECRET_ROUNDS` times, or the route resolves to error or degraded, the `.then` does nothing: no toast, and the dropped files are simply forgotten. In the same handler, the other not-ready states do show a `uiToast.info` explaining why.

## Why it matters

The user dropped files and answered or dismissed a prompt, and then nothing visible happens. This is the same silent-cancel pattern UX-012 fixed for the sidebar connect.

## Evidence

- `src/components/RemoteDesktop/RemoteDesktopTab.tsx:122-128`
- `src/hooks/useRemoteDesktopFiles.ts:43`
- `src/hooks/useRemoteDesktopFiles.ts:108-131`

## Recommendation

In the `.then`, handle every result that is not "ready": on cancel, `uiToast.info("Upload canceled", { description: "The linked SSH password is needed to upload files." })`; on error, degraded or exhausted rounds, reuse the existing `why` copy (or `next.message`). Add a test for a drop followed by a canceled prompt.

## Verification

Confirmed. RemoteDesktopTab.tsx:124-126 uploads only when the refresh result is ready; any other result (canceled prompt, error, degraded after MAX_SECRET_ROUNDS) leaves the drop discarded with no toast, while the sibling not-ready branches do toast. Mitigations: the user cancels the prompt themselves, and settle() updates the files status, so the Files button reflects the degraded or error state. Low severity.
