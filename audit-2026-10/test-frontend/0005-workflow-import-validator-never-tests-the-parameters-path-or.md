---
id: TFE2-005
title: "Workflow import validator never tests the parameters path or malformed run-local-process input"
angle: test-frontend
severity: low
category: test-gap
is_workaround: false
subsystem: "src/services/workflowIo.ts"
evidence:
  - src/services/workflowIo.ts:402-444
  - src/services/workflowIo.ts:484-494
  - src/services/workflowIo.ts:230-237
  - src/services/workflowIo.ts:200-217
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

workflowIo.ts validates imported workflow JSON, which comes from a file the user picks and can contain `run-local-process` steps (program and args). It is at 74% lines / 71% branches. `validateParameter` (lines 402-444, the PROD-0040 parameter import/round-trip) has 0 hits, and `parameters` never appears in workflowIo.test.ts. The rejection branches for malformed `run-local-process` (missing program, non-string args, lines 232/235), for `run-script` delay/sourcePath (203-216) and for `wait` delayMs are also uncovered.

## Why it matters

This is a trust boundary: a crafted or corrupted workflow file is parsed here before it can drive local process execution. The module's header says it was kept pure precisely so it could be unit-tested in isolation, yet its negative paths and the parameter round-trip are unverified. A regression that lets malformed args through, or drops parameters on export/import, would not be caught.

## Evidence

- `src/services/workflowIo.ts:402-444`
- `src/services/workflowIo.ts:484-494`
- `src/services/workflowIo.ts:230-237`
- `src/services/workflowIo.ts:200-217`

## Recommendation

Add workflowIo.test.ts cases for: a parameters round-trip of each type, with label/default/required/options preserved and no empty `parameters` key added; each validateParameter rejection; non-array parameters; and `run-local-process` with a missing program, non-array args and non-string args, plus the run-script and wait invalid-delay rejections. Assert on the specific error messages. Consider adding src/services/\*\* (or workflowIo specifically) to the per-path coverage floors.

## Verification

Mostly confirmed. validateParameter and the parameters path have no test in workflowIo.test.ts. appStore.workflowRun.test.ts only uses in-memory parameters and never goes through import validation. The run-local-process missing-program and invalid-args rejections and the run-script delay/sourcePath rejections are untested. One claim is wrong: the invalid wait delayMs rejection is tested (workflowIo.test.ts:108-110). The validator code itself looks correct, and tests at line 240 cover import listing of local-process steps for consent, so this is a missing-coverage risk rather than a defect. Low.
