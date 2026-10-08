---
id: FES2-005
title: "useOsFileDrop registers its drag-drop listener without a disposed guard and leaks it if unmounted before registration resolves"
angle: frontend-state
severity: low
category: reliability
is_workaround: false
subsystem: src/hooks/useOsFileDrop.ts
evidence:
  - src/hooks/useOsFileDrop.ts:44
  - src/hooks/useOsFileDrop.ts:77
  - src/hooks/useOsFileDrop.ts:81
  - src/hooks/useSessionOwnershipSuperseded.ts:35
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:143
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

getCurrentWindow().onDragDropEvent(...).then(fn => { unlisten = fn; }) only assigns the unlisten handle. If the effect cleans up before the promise resolves, cleanup sees unlisten === null, and the listener registered moments later is never removed. There is also no .catch, so a failure becomes an unhandled rejection. Every other async-listen hook in src/hooks was moved to the `disposed ? un() : keep` pattern under FEC-017. This hook was missed, and it has since gained a third consumer (RemoteDesktopTab, 02e07a6ee) on top of usePaneFileDrop and FileBrowser.

## Why it matters

Panes and remote-desktop tabs unmount and remount during layout changes such as split, move and group switch, within one IPC round-trip. Each leaked listener stays on the window for the app's lifetime and runs its handler on every drag event. It is mostly inert, because the container ref becomes null, but it still costs work and calls setState on an unmounted component.

## Evidence

- `src/hooks/useOsFileDrop.ts:44`
- `src/hooks/useOsFileDrop.ts:77`
- `src/hooks/useOsFileDrop.ts:81`
- `src/hooks/useSessionOwnershipSuperseded.ts:35`
- `src/components/RemoteDesktop/RemoteDesktopTab.tsx:143`

## Recommendation

Adopt the FEC-017 pattern: `let disposed = false; ... .then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(err => frontendLog(...))`. In cleanup, set `disposed = true` before calling unlisten.

## Verification

Confirmed. useOsFileDrop.ts:44-82 does `.then(fn => { unlisten = fn; })` with no disposed guard and no .catch. A cleanup that runs before the promise resolves leaves the window-level drag-drop listener registered for the app's lifetime, and a failure becomes an unhandled rejection. The hook has three consumers that mount and unmount with pane layout changes. The effect is mostly inert extra work plus setState after unmount, so low.
