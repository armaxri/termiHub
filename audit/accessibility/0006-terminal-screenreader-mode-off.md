---
id: A11Y-006
title: Terminal output is not exposed to assistive tech by default (xterm screenReaderMode off)
angle: accessibility
severity: medium
category: a11y
is_workaround: false
subsystem: src/components/Terminal
evidence:
  - src/components/Terminal/Terminal.tsx:1179
status: open
---

## What

The terminal is the core surface of the app, and its xterm instance is created with
`screenReaderMode: appSettings.screenReaderMode ?? false` (Terminal.tsx:1181). xterm's screen-reader
mode — which mirrors terminal output into an offscreen live region that AT can read and lets AT
navigate rows — is therefore **off unless the user discovers and enables a setting**. With it off,
a blind user hears nothing of command output; the `<canvas>`/DOM cells xterm paints are not exposed
as readable text.

The default is a deliberate xterm performance tradeoff (the live-region mirror adds per-write
overhead), and the code comment acknowledges it. But shipping it off-by-default with no in-app
prompt means the terminal is, out of the box, inaccessible to screen-reader users.

## Why it matters

- **WCAG 1.3.1 / 4.1.2 (A)** — terminal content and its updates are not programmatically available
  to AT in the default configuration.
- **WCAG 4.1.3 Status Messages (AA)** — output that appears without focus change isn't announced.

This is a genuine tension (perf vs. AT), which is why it's medium rather than an outright block: a
setting exists, and enabling it makes the terminal accessible. The gap is discoverability and
default posture.

## Evidence

`src/components/Terminal/Terminal.tsx:1179-1181`:

```tsx
// Opt-in screen-reader mode (#2071): mirrors output into a live region for
// assistive technology. Off by default (adds rendering overhead).
screenReaderMode: appSettings.screenReaderMode ?? false,
```

## Recommendation

- Auto-enable `screenReaderMode` when the OS/AT signals a screen reader is active where detectable,
  or on first run surface a discoverable prompt / clearly-labeled accessibility setting rather than
  leaving it buried.
- Ensure the setting is itself easy to find and named for what it does ("Screen reader support —
  expose terminal output to assistive technology").
- Document the setting in user-facing accessibility docs and the manual-test matrix (a real
  screen-reader pass on macOS VoiceOver / Windows NVDA is required to verify — cannot be unit
  tested).
