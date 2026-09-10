---
id: UX-019
title: Transfer rows show percent and speed but never an ETA / time-remaining
angle: ux-flows
severity: low
category: ux
is_workaround: false
subsystem: src/components/TransferQueue
evidence:
  - src/types/transfer.ts:55
  - src/components/TransferQueue/TransferEntry.tsx:89
status: open
---

## What
`TransferEntry` has `percent` and `speedBytesPerSec` but **no ETA / time-remaining field**
(`types/transfer.ts:55-58`), and `TransferEntry.tsx:89-91` renders percent + throughput only. There
is no "3 min remaining." For indeterminate transfers (`percent == null`, `TransferEntry.tsx:62`) the
percent cell is empty and there is no byte-count-of-total, so the user cannot judge progress at all
on a size-unknown download.

## Why it matters
For large SFTP transfers, throughput alone doesn't tell the user how long to wait. ETA is a baseline
expectation of a transfer UI, and its absence makes long transfers feel opaque.

## Evidence
- `types/transfer.ts:55-58` — no time-remaining field.
- `TransferEntry.tsx:62,89-91` — percent + speed only; empty percent on indeterminate.

## Recommendation
Compute and display an ETA from bytes-remaining / rolling average speed, plus a
"transferred / total" byte count. Where total is unknown, show transferred bytes so progress is at
least visible.
