---
id: LIBFE2-001
title: "Hand-rolled ANSI stripper (two copies) ignores OSC sequences, so the output triggers and wait-for-output match against escape garbage"
angle: lib-usage-frontend
severity: medium
category: correctness
is_workaround: false
subsystem: "src/services/workflowOutputTriggers, src/store/slices/workflowRunOnTarget"
status: open
resolution: ""
audit: 2026-10
commit: "663465d52"
relation: new
evidence:
  - src/services/workflowOutputTriggers.ts:113
  - src/services/workflowOutputTriggers.ts:314
  - src/store/slices/workflowRunOnTarget.ts:80
  - src/store/slices/workflowRunOnTarget.ts:425
  - src-tauri/src/connection/settings.rs:719
---

## What

Two identical copies of a hand-rolled regex, `/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g`, strip ANSI before matching. The pattern is an old ansi-regex-style CSI-only matcher and never matches an OSC sequence (ESC ] ... BEL/ST). I checked this with node: `"\u001b]0;arne@box: ~\u0007arne@box:~$ \u001b]133;B\u0007"` comes back unchanged, ESC bytes and all. It also misses the colon-form SGR (`38:2:r:g:b`) and `~`-terminated CSI such as the bracketed-paste markers `\e[200~`/`\e[201~`. Shell integration emits OSC 133 marks and defaults to ON for SSH (`default_shell_integration: true`). Standard bash prompts and OSC 7 also emit OSC 0/2 window titles. As a result the text fed to on-output-match triggers and wait-for-output steps contains `]133;B`, `]0;user@host: ~` and raw ESC/BEL. A third issue: wait-for-output strips each chunk separately, so a sequence split across two PTY chunks is never stripped.

## Why it matters

Workflow triggers and waits are automation the user relies on, and they can mis-fire or stall silently. A pattern anchored at the prompt (for example `\$ $`) never matches, because the OSC 133;B mark follows the prompt. A plain-text pattern can match early on window-title text that is invisible on screen. The run then times out or fires at the wrong moment, and nothing visible explains why. The maintained `ansi-regex`/`strip-ansi` (sindresorhus) handle OSC with BEL/ESC\\/0x9c terminators, colon params and `~` finals. Both are already in the lockfile as transitive dependencies (ansi-regex@6.2.2, strip-ansi@7.2.0), so they are vetted and add almost nothing to the bundle.

## Recommendation

Add `strip-ansi` (or `ansi-regex`) as a direct dependency and have one shared `stripAnsi()` in src/utils use it. Delete both local `ANSI_ESCAPE_RE` copies. In wait-for-output, strip the accumulated buffer, or keep a trailing incomplete escape as carry-over, so split sequences are removed too. Add regression tests with the existing OSC 133 fixtures (src/test/fixtures/osc133/bash.json, zsh.json) asserting that no ESC, BEL or `]133;` remains after stripping and that a `\$ $`-anchored pattern matches.

## Verification

Confirmed. The same CSI-only regex appears at workflowOutputTriggers.ts:113 and workflowRunOnTarget.ts:80, and it has no OSC branch. The raw PTY stream does carry OSC 133: src/services/commandMarks.ts parses it on the frontend from the same output, and default_shell_integration is true (settings.rs:719). wait-for-output strips each decoded chunk on its own (feed at workflowRunOnTarget.ts:425/446), so a sequence split across chunks survives. The triggers path strips only the new chunk before appending it to the tail, which has the same split problem. I found nothing that strips OSC upstream.
