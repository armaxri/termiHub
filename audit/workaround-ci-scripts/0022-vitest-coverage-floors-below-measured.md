---
id: WA-CI-022
title: vitest coverage floors deliberately set a few points below measured coverage (ratchet)
angle: workaround-ci-scripts
severity: info
category: test-gap
is_workaround: true
subsystem: vitest.config.ts
evidence:
  - vitest.config.ts
status: open
---

## What
The frontend coverage thresholds (lines 75/74/70/67 for lines/statements/functions/branches)
are set "a few points below" the measured develop values (78.5/… %) so "normal fluctuation
passes but a genuine drop trips the gate" (#2066). It is explicitly a ratchet, not a target.

## Why it matters
Not a defect — this is an intentional, documented ratchet. Catalogued because a "floor below
actual" gate can quietly permit real coverage erosion within the slack band, and ratchets only
work if someone actually raises them. The `include: ["src/**/*.ts"]` also excludes `.tsx`
components from the coverage denominator, so component render coverage is not measured by this
gate.

## Evidence
`thresholds` block and the coverage `include`/`exclude` in `vitest.config.ts`.

## Recommendation
Keep, but honor the ratchet: periodically raise the floors toward measured, and consider
including `.tsx` in coverage so component logic counts. Info.
