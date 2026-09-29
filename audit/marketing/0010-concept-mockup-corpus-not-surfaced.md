---
id: MKT-010
title: Rich concept/mockup corpus (a strong maturity signal) is invisible to prospective users
angle: marketing / credibility
severity: low
category: docs
is_workaround: false
subsystem: README.md / docs/concepts
evidence:
  - README.md:501
  - docs/concepts/README.md:42
  - docs/concepts/mockups-index.html
status: open
---

## What
The repo contains 48 polished, self-contained HTML **concept/design documents** with mockups
and diagrams, plus a browsable gallery (`docs/concepts/mockups-index.html`). This is an unusual
depth of design maturity for a pre-v0.1.0 project and a credible trust signal.

The README's "Documentation" section (README.md:501–506) links only four dev-facing docs
(architecture, contributing, testing, remote-protocol). It never points prospective users at
the concept gallery or any design material. The only concept link in the whole README is a
single incidental one (workflow-automation) — which is also broken (see MKT-012).

## Why it matters
Design depth is evidence of seriousness and reduces a prospect's "is this a weekend project?"
risk. Surfacing even a couple of the best mockups (or the gallery) would reinforce the
polished-product impression the shopfront otherwise fails to convey. Low severity because it's
an opportunity rather than a defect, but cheap to capture.

## Evidence
- `README.md:501-506` — Documentation section, dev docs only.
- `docs/concepts/README.md` + `docs/concepts/mockups-index.html` — the unsurfaced corpus.

## Recommendation
- Add a "Design & concepts" link to the Documentation section pointing at
  `docs/concepts/` (and note the gallery renders in a browser, not on github.com).
- Consider embedding 2–3 of the strongest mockup previews as illustrative images in the feature
  sections (with a caption noting they're design mockups, not screenshots — keep the distinction
  honest per MKT-003).
