---
id: PERF2-003
title: "Syntax highlighting breaks once scrollback is full: new lines are never scanned and existing decorations are disposed"
angle: performance
severity: medium
category: correctness
is_workaround: false
subsystem: src/services/syntaxHighlighting.ts
status: fixed
resolution: "#4354 — rows tracked as buffer row + trimmed count (cursor-anchored marker), so new lines scan and decorations survive trimming"
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - src/services/syntaxHighlighting.ts:370
  - src/services/syntaxHighlighting.ts:493
  - src/services/syntaxHighlighting.ts:505
  - src/services/syntaxHighlighting.ts:523
  - src/services/syntaxHighlighting.ts:567
  - node_modules/@xterm/xterm/src/common/services/BufferService.ts:94
  - src/components/Terminal/Terminal.tsx:96
---

## What

The engine tracks progress and decorations by absolute buffer row. `scannedThrough = cursorAbs - 1` (505), `from = scannedThrough + 1` (493), and `lineDisposables` and `dirtyQueue` are keyed by that row (370/523). Once xterm's circular buffer is full (after `scrollback` lines, default 10,000 at Terminal.tsx:96), xterm stops incrementing `ybase` and recycles the top line (BufferService.ts:80-95). `cursorAbs` then stays constant while content shifts up under it. Each `onWriteParsed` then enqueues only the cursor row, so every line that scrolled past in that write is never scanned. `scanLine(cursorRow)` also calls `disposeLine(cursorRow)` (567), which disposes the decorations of whatever line was last tracked under that index, a line that has since moved up. Deferred rows in `dirtyQueue` (throttle path) refer to rows that have shifted too. The existing tests only cover a matched line scrolling out of the buffer (#2073), not new output after the buffer is full.

## Why it matters

In a long session (any build or log tail past about 10k lines), highlighting quietly stops working. ERROR/WARN lines stop being colored, and the highlight on the line just written is removed on the next write. Highlighting is default-off but a user-facing feature, and its value is highest in exactly these long, noisy sessions. The cost of the bad bookkeeping also lands on the hot path while it no longer does anything useful.

## Evidence

- `src/services/syntaxHighlighting.ts:370`
- `src/services/syntaxHighlighting.ts:493`
- `src/services/syntaxHighlighting.ts:505`
- `src/services/syntaxHighlighting.ts:523`
- `src/services/syntaxHighlighting.ts:567`
- `node_modules/@xterm/xterm/src/common/services/BufferService.ts:94`
- `src/components/Terminal/Terminal.tsx:96`

## Recommendation

Stop using absolute row numbers once the buffer can trim. Either (a) subscribe to `xterm.buffer.active` trim events (`onTrim` via a proposed API, or by detecting an unchanged `baseY` with growing output) and shift `scannedThrough`, `dirtyQueue` and `lineDisposables` keys down by the trimmed amount, or (b) key lines by `IMarker`, whose `.line` xterm keeps current, and compute the dirty range from a marker set at the last scanned line. Add a regression test with a real xterm, `scrollback: 5`, where 50 matching lines are written after the buffer is full and every visible match must be decorated.

## Verification

Confirmed. enqueueDirtyLines uses an absolute `cursorAbs = baseY + cursorY` and sets `scannedThrough = cursorAbs - 1`. Once the buffer is full, baseY stays fixed, so `from == cursorAbs` and only the cursor row gets enqueued. Trim handling exists only as marker.onDispose cleanup of the Map (#2073). Nothing shifts scannedThrough, dirtyQueue or the lineDisposables keys. scanLine(startRow) calls disposeLine(startRow) by absolute key, so it disposes decorations of the line that has since moved up. Highlighting stops working once a session passes the scrollback limit. The feature is default-off, which keeps this at medium.
