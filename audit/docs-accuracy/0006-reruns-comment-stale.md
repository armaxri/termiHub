---
id: DOC-006
title: system-integration CI comments say "--reruns 2" but every command uses "--reruns 4"
angle: docs-accuracy
severity: low
category: docs
is_workaround: false
subsystem: .github/workflows/system-integration
evidence:
  - .github/workflows/system-integration.yml:278
  - .github/workflows/system-integration.yml:288
status: open
---

## What

In `.github/workflows/system-integration.yml`, explanatory comments say `# --reruns 2
--reruns-delay 1 (#2698)` while the actual pytest invocations use `--reruns 4 --reruns-delay 1`.
The comment (a doc-of-intent) contradicts the code it annotates.

## Why it matters

Rerun count directly encodes how much flake the integration lane is masking. A comment claiming 2
while the command retries 4 misleads anyone reasoning about test flakiness / the flake budget, and
the "(#2698)" reference makes the stale number look authoritative.

## Evidence

- Comments `# --reruns 2 --reruns-delay 1 (#2698)` at lines 278, 346, 495.
- Actual commands `--reruns 4 --reruns-delay 1` at line 288 (Linux), 352 (macOS/Windows), 503, 517.
- `tests/system/pyproject.toml` sets no `reruns` ini value, so the workflow flags are authoritative.

## Recommendation

Update the three comments to `--reruns 4` (or reduce the actual flag to 2 if 4 was not intended);
retries this high on a merge-gating lane are also worth a flake-tracker note.
