---
id: FES2-001
title: "requestPassword keeps a single resolver: a second concurrent prompt overwrites the first, and the first connect hangs forever"
angle: frontend-state
severity: medium
category: correctness
is_workaround: false
subsystem: src/store/slices/passwordPromptSlice.ts
evidence:
  - src/store/slices/passwordPromptSlice.ts:91
  - src/store/slices/passwordPromptSlice.ts:97
  - src/store/slices/passwordPromptSlice.ts:106
  - src/store/slices/passwordPromptSlice.ts:115
  - src/store/slices/credentialStoreSlice.ts:32
  - src/store/slices/credentialStoreSlice.ts:82
  - src/hooks/useSpawnRequests.ts:124
  - src/hooks/useSpawnRequests.ts:133
  - src/hooks/useRemoteDesktopFiles.ts:116
  - src/utils/connectSavedConnection.ts:476
  - src/utils/graphicalSecret.ts:89
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

requestPassword() creates a new Promise and writes its resolve into the single field passwordPromptResolve. It also overwrites host, username, notice, kind and allowSave without checking whether a prompt is already open. If a second request arrives while the first prompt is showing, the first promise's resolver is lost: neither submitPassword nor dismissPasswordPrompt can ever settle it. Callers then read the global passwordPromptShouldSave after the await, so the Save choice belongs to whichever prompt was answered last, not the caller's own. Independent sources can call requestPassword concurrently: spawn requests (useSpawnRequests → resolveSpawnSecret, one per incoming spawn-request event), the new VNC linked-SSH secret flow (useRemoteDesktopFiles), saved-connection connects, agent connects in AgentNode, and graphical-secret resolution.

## Why it matters

The credential-store unlock dialog had exactly this bug, and it was fixed (credentialStoreSlice keeps an unlockResolvers list for concurrent connect flows, per G1: 'a single resolver would be overwritten by the second caller, wedging the first connect forever'). The password prompt was never given the same fix. Example: two `termihub spawn --connection <ssh>` requests arrive close together, or a VNC file-channel secret request comes in while an SSH prompt is up. The user sees only the second host's prompt. The first connect never completes or cancels, and no error or toast appears. A Save tick on one prompt can also store a secret for the other flow, or skip storing it.

## Evidence

- `src/store/slices/passwordPromptSlice.ts:91`
- `src/store/slices/passwordPromptSlice.ts:97`
- `src/store/slices/passwordPromptSlice.ts:106`
- `src/store/slices/passwordPromptSlice.ts:115`
- `src/store/slices/credentialStoreSlice.ts:32`
- `src/store/slices/credentialStoreSlice.ts:82`
- `src/hooks/useSpawnRequests.ts:124`
- `src/hooks/useSpawnRequests.ts:133`
- `src/hooks/useRemoteDesktopFiles.ts:116`
- `src/utils/connectSavedConnection.ts:476`
- `src/utils/graphicalSecret.ts:89`

## Recommendation

Make the prompt a FIFO queue of {host, username, notice, kind, allowSave, resolve}. Show the head entry, and on submit or dismiss resolve only that entry, then advance to the next. Return shouldSave together with the password, for example as resolve({password, shouldSave}) or a companion field per request, instead of having callers read the global passwordPromptShouldSave after the await. Add a regression test: two overlapping requestPassword calls must each settle with their own answer.

## Verification

Confirmed. passwordPromptSlice.ts:91-103 overwrites the single passwordPromptResolve and all of the prompt fields with no open-prompt check or queue. submit and dismiss settle only the current resolver, so an earlier awaiting caller is wedged forever. Several independent callers can run concurrently: resolveSpawnSecret, called per spawn event; connectSavedConnection; linkedSshSecret, called from useRemoteDesktopFiles; and graphicalSecret/agentGraphicalSecret. useSpawnRequests.ts:133 reads the global passwordPromptShouldSave after the await, so the Save choice can belong to another prompt. credentialStoreSlice already fixed this exact pattern with an unlockResolvers list (G1). No ADR or serialization layer covers the password prompt.
