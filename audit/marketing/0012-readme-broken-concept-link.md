---
id: MKT-012
title: README links a concept doc at the wrong path (stale backlog/ location) — broken link on the shopfront
angle: marketing / docs accuracy
severity: low
category: docs
is_workaround: false
subsystem: README.md
evidence:
  - README.md:120
  - docs/concepts/implemented/workflow-automation.html
status: open
---

## What
README.md:120 links the Workflow Automation design reference as
`docs/concepts/backlog/workflow-automation.html`, but the file actually lives at
`docs/concepts/implemented/workflow-automation.html` (it graduated to *implemented*). The
linked path does not exist — a **broken link** on the primary marketing surface.

Two things are wrong at once: the path is stale, and the `backlog/` location misrepresents the
feature's status (it's shipped, not backlog).

## Why it matters
A 404 in the README erodes the polished-product impression and signals doc drift. Low severity
(single link, and link accuracy is largely owned by the docs-accuracy angle), but it sits on
the shopfront and is trivially fixable. Included here because it's on the marketing surface.

## Evidence
- `README.md:120` — links `docs/concepts/backlog/workflow-automation.html` (nonexistent).
- `docs/concepts/implemented/workflow-automation.html` — the real location.

## Recommendation
- Fix the link to the `implemented/` path.
- Add a CI/link-check (or a lint) over the README's relative doc links so concept
  promotion/relocation can't silently break shopfront links again. (Coordinate with the
  docs-accuracy angle to avoid duplicate remediation.)
