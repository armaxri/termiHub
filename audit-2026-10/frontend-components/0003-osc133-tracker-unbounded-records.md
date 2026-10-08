---
id: FEC2-003
title: "OSC 133 tracker has no bound: repeated A/C/D marks on one line pile up records, markers and decorations, and every prune is O(n)"
angle: frontend-components
severity: low
category: robustness
is_workaround: false
subsystem: "src/services/commandMarks"
evidence:
  - src/services/commandMarks.ts:446-458
  - src/services/commandMarks.ts:474-477
  - src/services/commandMarks.ts:509-515
  - src/services/commandMarks.ts:710-718
  - src/components/Terminal/Terminal.tsx:1693
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The OSC 133 handler is registered on every terminal (`Terminal.tsx:1693`). `onPromptStart` skips a repeated `A` only while the current record is still in the `prompt` state on the same line. `onOutputStart` and `onInputStart` open a new record whenever the current one is `finished`. So repeating `ESC]133;A BEL ESC]133;C BEL ESC]133;D;1 BEL` without a newline creates a new record, two or three xterm markers and a gutter decoration every time, all on the cursor line. Records are dropped only when their prompt marker is disposed (`prune`), which happens when the line is trimmed from scrollback. That never happens to the cursor line. `prune()` walks every record on every mark, so cost grows quadratically.

## Why it matters

Any remote output can drive this: a hostile host, a `cat` of a file containing these sequences, or a buggy prompt that redraws in a loop. Memory, marker and decoration counts grow without limit, and the mark parser slows down quadratically, which can freeze or exhaust a terminal tab. The module says it is designed to be forgiving and never throw, but it does not cap its own state.

## Evidence

- `src/services/commandMarks.ts:446-458`
- `src/services/commandMarks.ts:474-477`
- `src/services/commandMarks.ts:509-515`
- `src/services/commandMarks.ts:710-718`
- `src/components/Terminal/Terminal.tsx:1693`

## Recommendation

Cap `records` (for example at about 10k, dropping and disposing the oldest). Treat a new `A`/`B`/`C` on the same line as the current record's prompt as the same prompt whatever its state, or merge consecutive empty records on one line. Make pruning incremental, for example by pruning only from the front, since records are ordered by line.

## Verification

Confirmed in `commandMarks.ts`. `onPromptStart` skips only when the record is in state `prompt` on the same line. `onOutputStart` and `onInputStart` call `startRecord()` when the current record is finished. `startRecord`/`anchorAtCursor` register a new xterm marker every time and `finish` adds a decoration. Nothing caps `records`, and `prune()` walks the whole array on every `apply()`. So a stream of repeated A/C/D on one line grows state without limit, and the cost per mark grows with the record count. I lowered severity because it needs crafted or odd remote output (or `cat` of such a file). The impact is one terminal tab slowing down, not a security or data problem.
