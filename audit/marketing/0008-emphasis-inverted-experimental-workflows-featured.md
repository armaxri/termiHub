---
id: MKT-008
title: Feature emphasis is inverted — an experimental feature gets a large section while shipped flagships get nothing
angle: marketing / product positioning
severity: medium
category: docs
is_workaround: false
subsystem: README.md
evidence:
  - README.md:111
  - README.md:75
status: open
---

## What
The README's Features section devotes its single largest, most detailed block — with a warning
callout, step-type breakdown, and trigger list (README.md:111–120) — to **Workflow Automation,
which is explicitly experimental and off by default** (behind Allow Experimental Features).

Meanwhile shipped, on-by-default flagship capabilities (RDP/VNC, plugins, network diagnostics,
multi-window, tunnels' depth, session restore) receive **little or no** README space (see
MKT-001, MKT-002). The prominence is inverted: the thing a user *cannot even see* without
flipping a toggle is the most heavily marketed feature on the page.

## Why it matters
Section size signals importance. Giving the most words to an experimental, default-off feature
misdirects the reader's attention away from the mature, immediately-usable capabilities that
should drive adoption. It also risks the impression that the flagship is a not-yet-ready power
feature, when in fact the product's mature surface is broad.

## Evidence
- `README.md:111-120` — large "Workflow Automation (experimental)" section with callout + detail.
- `README.md:75-110` — mature connection types and features get terse one-liners; RDP/VNC/
  plugins/network-tools absent entirely.

## Recommendation
- Rebalance: lead Features with the mature, on-by-default flagships (connections incl. RDP/VNC,
  plugins, network tools, tunnels, session restore). Keep Workflow Automation, but condense it
  and move it to an "Experimental / power-user" subsection so its prominence matches its status.
- Apply the same experimental labeling consistently — RDP/VNC is *also* experimental-gated but
  currently gets no honest "experimental" marker at all (MKT-001).
