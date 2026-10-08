---
id: MKT2-008
title: "Concept index has a broken `partial/` link and omits two concept documents"
angle: marketing / product positioning
severity: low
category: docs-accuracy
is_workaround: false
subsystem: "docs/concepts"
evidence:
  - "docs/concepts/README.md:8"
  - "docs/concepts/README.md:98-103"
  - "docs/concepts/backlog/wsl-path-expansion-semantics.html"
  - "docs/concepts/future/agent-tunnel-chain-desktop-hop.html"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

docs/concepts/README.md:8 links to [`partial/`](partial/), but that directory does not exist in the tree (git does not track empty directories), so the link 404s on GitHub. The index also does not list docs/concepts/backlog/wsl-path-expansion-semantics.html or docs/concepts/future/agent-tunnel-chain-desktop-hop.html.

## Why it matters

The concept corpus is one of the project's strongest presentation assets (MKT-010). Its own index should not have dead links or missing entries. This is the same class of defect as the fixed MKT-012.

## Evidence

- `docs/concepts/README.md:8`
- `docs/concepts/README.md:98-103`
- `docs/concepts/backlog/wsl-path-expansion-semantics.html`
- `docs/concepts/future/agent-tunnel-chain-desktop-hop.html`

## Recommendation

Either render `partial/` as plain text (no link) while it is empty, or add docs/concepts/partial/.gitkeep. Add the two missing concepts to their status sections in docs/concepts/README.md. Optionally, make build-mockups-index.sh or a CI lint check that every concept file is listed in the README index.

## Verification

Confirmed. docs/concepts/README.md:8 links partial/, but that directory does not exist (ls docs/concepts shows only implemented/backlog/future/\_assets). Both wsl-path-expansion-semantics.html and agent-tunnel-chain-desktop-hop.html exist and neither is mentioned in the README index.
