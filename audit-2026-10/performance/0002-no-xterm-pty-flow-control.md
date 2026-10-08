---
id: PERF2-002
title: "No flow control from xterm back to the PTY: output can overrun xterm's 50 MB write watermark, and the frontend buffer grows without limit"
angle: performance
severity: medium
category: perf
is_workaround: false
subsystem: src/components/Terminal/Terminal.tsx, core/src/session/pump.rs, src-tauri/src/session/output_sink.rs
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - core/src/session/pump.rs:212
  - src-tauri/src/session/output_sink.rs:74
  - src-tauri/src/session/manager.rs:220
  - src/components/Terminal/Terminal.tsx:885
  - src/components/Terminal/Terminal.tsx:987
  - src/components/Terminal/Terminal.tsx:1057
  - node_modules/@xterm/xterm/src/common/input/WriteBuffer.ts:104
---

## What

The output pump drains the bounded PTY channel as fast as `emit_output` returns. A Tauri emit is fire-and-forget, so `sink.send_output` never pushes back (pump.rs:212, output_sink.rs:74). The webview queues every event. Terminal.tsx pushes each chunk into a plain unbounded `outputBuffer` (885/1057) and writes the merged batch to xterm on each RAF/16 ms tick (987). It never checks xterm's write backlog and never acknowledges consumption to the backend. xterm.js 6 throws `write data discarded, use flow control to avoid losing data` once more than 50 MB is pending (WriteBuffer.ts:104). In flushOutput that throw happens before `outputBuffer.length = 0`, so the batch stays queued, keeps growing, and the throw repeats on every flush until xterm drains.

## Why it matters

A fast local producer (`cat` of a large log, `yes`, `find /`, a chatty build) can outrun xterm's parser plus the base64/eval IPC. Memory then piles up in three unbounded places: the Tauri event queue, `outputBuffer`, and xterm's own buffer. The UI becomes sluggish or freezes, Ctrl-C reaches the shell late because the terminal is still rendering stale output, and once the 50 MB watermark is hit a stream of uncaught errors goes to the error log. Native terminals and VS Code solve this with ack-based flow control, which pauses the PTY reader while unacknowledged bytes exceed a high-water mark.

## Evidence

- `core/src/session/pump.rs:212`
- `src-tauri/src/session/output_sink.rs:74`
- `src-tauri/src/session/manager.rs:220`
- `src/components/Terminal/Terminal.tsx:885`
- `src/components/Terminal/Terminal.tsx:987`
- `src/components/Terminal/Terminal.tsx:1057`
- `node_modules/@xterm/xterm/src/common/input/WriteBuffer.ts:104`

## Recommendation

Add watermark flow control: count bytes handed to xterm.write and subtract them in the write callback. When pending exceeds a high-water mark (for example 5–10 MB), send a `pause_output(session_id)` intent and send `resume_output` below a low-water mark. On the backend, have the pump stop reading the channel while paused, which then backpressures the PTY reader thread through the bounded channel. As a local safety net, cap `outputBuffer` and wrap `xterm.write` in try/catch that keeps the data queued without throwing per frame. Add a test that floods a session and checks frontend memory stays bounded.

## Verification

Confirmed. The pump calls sink.send_output, which runs emitter.emit_output and returns Ok whenever the webview exists. Nothing feeds frontend consumption back to the backend, so the bounded PTY channel never applies backpressure past the emit. In Terminal.tsx, outputBuffer is a plain unbounded array, and flushOutput calls xterm.write without checking the backlog. The 'write data discarded' throw comes before `outputBuffer.length = 0`, so the batch stays queued and the throw repeats. No pause or resume intent exists anywhere (grep found none). architecture.md only claims bounded-channel backpressure on the backend side. The IPC is probably the slower stage, so the queue more likely builds up in the webview event queue than at xterm's 50 MB mark, but output is still unbounded either way.
