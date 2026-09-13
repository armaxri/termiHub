---
id: I18N-016
title: UTF-8 handling is sound by design, but IME/Unicode input is untested
angle: i18n
severity: low
category: test-gap
is_workaround: false
subsystem: src/components/Terminal, src/services/events
evidence:
  - src/services/events.ts:46
  - src/components/Terminal/Terminal.tsx:858
status: open
---

## What
Terminal encoding is handled correctly and this finding records that (so it is
not re-flagged) while noting the one real gap — input-method / Unicode input is
not covered by any automated test.

What is sound:
- Backend output is base64-encoded and decoded byte-for-byte
  (`base64ToBytes`, events.ts:46) — high bytes and multi-byte UTF-8 sequences
  survive intact (documented, #2072).
- Raw `Uint8Array` bytes are handed to `xterm.write()`
  (Terminal.tsx:858/869), and xterm.js owns a **stateful UTF-8 decoder** that
  correctly buffers multi-byte sequences split across output chunks — so no
  byte-boundary corruption of non-ASCII terminal output.
- File contents use `TextDecoder`/`TextEncoder` (FileEditor.tsx:88/97).

The gap:
- There is **no automated coverage** for IME composition input (CJK, Korean,
  accented dead-keys), pasting/typing non-ASCII, RTL text, combining characters,
  or emoji into the terminal or the app's inputs. Per the audit context this is a
  known manual-test gap. No app-level `compositionstart`/`compositionend`
  handling exists (the terminal relies on xterm's textarea; app inputs rely on
  browser defaults) — which is *probably* fine, but is unverified.

## Why it matters
Bucket B, low. Encoding correctness looks good, but "looks good, untested" on a
cross-platform terminal that will be used internationally is a reliability gap:
IME quirks are platform- and webview-specific (WKWebView vs WebView2 vs
WebKitGTK behave differently), exactly where regressions hide.

## Evidence
- `src/services/events.ts:46` — faithful base64→bytes.
- `src/components/Terminal/Terminal.tsx:858,869` — bytes to `xterm.write`.
- No `compositionstart`/`isComposing` handling found anywhere in `src/**`.

## Recommendation
Add a small suite (or bridge/manual checklist promoted to docs/testing.md)
covering: typing/pasting CJK via IME, an RTL string, a combining-accent
sequence, and an emoji, into (a) the terminal and (b) a text input, on each
webview platform. Assert round-trip through the PTY and correct rendering. This
is verification, not new code — the encoding plumbing itself appears correct.
