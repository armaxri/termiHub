---
id: WA-CI-033
title: default.dev.local.json template ships dev_agent_port 2222 which collides with E2E SSH
angle: workaround-ci-scripts
severity: info
category: workaround
is_workaround: true
subsystem: default.dev.local.json
evidence:
  - default.dev.local.json
status: open
---

## What
`default.dev.local.json` (the copy-me template for the gitignored per-checkout
`dev.local.json`) ships `"dev_agent_port": 2222`. Per the coordinator notes and #1536, port
2222 collides with the E2E SSH container, which is why checkout 0's live `dev.local.json` uses
2600 instead. So the committed template's default is a known-colliding value that must be hand-
edited per checkout.

## Why it matters
A template whose default value is known to collide is a latent foot-gun: a fresh clone that
copies the template verbatim (or a checkout that forgets to change 2222) fights the E2E SSH
container for the port, producing flaky cross-checkout test failures that look like real bugs
(the documented failure mode). It is a config-level stopgap that relies on every user knowing to
override it.

## Evidence
`"dev_agent_port": 2222` in `default.dev.local.json`; #1536 documents the 2222↔E2E-SSH
collision; dev0 uses 2600 deliberately.

## Recommendation
Set the template's `dev_agent_port` to a non-colliding default (e.g. 2600, matching dev0's
working value), or add an explicit `_comment` warning that 2222 collides with the E2E SSH
container and must be changed. This is purely a template default; the live files are correct.
Info.
