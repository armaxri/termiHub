---
id: UISF2-004
title: "Direct `sonner` imports bypass ui/toast, so some error toasts auto-dismiss despite the persist-errors policy"
angle: ui-shared-foundation
severity: low
category: ui
is_workaround: false
subsystem: "src/components/ui/Toast"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - src/components/ui/Toast/toast.ts:52
  - src/components/ui/Toast/toast.ts:105
  - src/components/Terminal/TerminalView.tsx:15
  - src/components/Terminal/TerminalView.tsx:363
  - src/components/Terminal/TerminalView.tsx:372
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:3
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:4
  - src/components/RemoteDesktop/RemoteDesktopClipboardImage.tsx:3
  - src/components/Terminal/FileBrowserTab.tsx:3
  - eslint.config.js:74
---

## What

ui/Toast wraps sonner and sets the app's toast policy: `error()` defaults to `duration: PERSIST_DURATION` (Infinity), so errors stay until dismissed. Four feature files import `toast` from "sonner" directly. TerminalView calls raw `toast.error('Failed to stop logging: …')` and `toast.error('Failed to start logging: …')`, which use sonner's default auto-dismiss. RemoteDesktopTab imports both sonner's `toast` and `toast as uiToast` in adjacent lines and mixes them.

## Why it matters

The session-logging start/stop failures disappear after a few seconds, while every other error in the app persists. That breaks the documented 'errors persist until dismissed' behaviour. Direct imports also skip the wrapper's testId/option subset, and nothing stops more of them.

## Evidence

- `src/components/ui/Toast/toast.ts:52`
- `src/components/ui/Toast/toast.ts:105`
- `src/components/Terminal/TerminalView.tsx:15`
- `src/components/Terminal/TerminalView.tsx:363`
- `src/components/Terminal/TerminalView.tsx:372`
- `src/components/RemoteDesktop/RemoteDesktopTab.tsx:3`
- `src/components/RemoteDesktop/RemoteDesktopTab.tsx:4`
- `src/components/RemoteDesktop/RemoteDesktopClipboardImage.tsx:3`
- `src/components/Terminal/FileBrowserTab.tsx:3`
- `eslint.config.js:74`

## Recommendation

Change the four files to `import { toast } from "@/components/ui"`. Remove the dual import in RemoteDesktopTab. Add `{ name: "sonner", message: "Use toast from @/components/ui" }` to the existing `no-restricted-imports` paths in eslint.config.js, with `src/components/ui/Toast/**` in `ignores`.

## Verification

Confirmed. TerminalView.tsx:15, RemoteDesktopTab.tsx:3, RemoteDesktopClipboardImage.tsx and FileBrowserTab.tsx import toast from 'sonner' directly. RemoteDesktopTab also imports uiToast on the next line. TerminalView's logging start/stop errors use raw sonner toast.error, so they auto-dismiss, against the PERSIST_DURATION policy in ui/Toast/toast.ts. eslint no-restricted-imports does not cover sonner.
