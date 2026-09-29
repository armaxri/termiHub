---
id: MKT-006
title: No at-a-glance feature/capability matrix — breadth is not scannable
angle: marketing / product positioning
severity: medium
category: docs
is_workaround: false
subsystem: README.md
evidence:
  - README.md:73
status: open
---

## What
termiHub's competitive edge is **breadth** (many protocols + power tools in one app), but the
README has no capability matrix or "supported at a glance" table. Breadth is buried in prose
bullets across a long Features section, so a scanning reader cannot quickly grasp "this does X,
Y, and Z that my current tool doesn't."

A matrix is also the honest place to encode **maturity/experimental state** per capability
(which the product-completeness audit shows varies a lot: SSH/tunnels/agents complete; RDP/VNC
experimental; Docker limited; some transfer controls dead).

## Why it matters
For a hub product, a compact matrix is the single most persuasive artifact: it communicates
breadth and lets a prospect confirm their specific protocol/tool is supported in seconds. Its
absence makes the product look narrower than it is and forces prospects to read a wall of text.

## Evidence
- `README.md:73-125` — long prose Features section, no summary table.
- `audit/product-completeness/_summary.md` — a completeness matrix already exists internally and
  could seed the public one.

## Recommendation
Add a **Supported connections** table (rows = local, SSH, serial, telnet, Docker, WSL, FTP/FTPS,
RDP, VNC, remote agent; columns = terminal / file transfer / monitoring / tunnels / persistent /
status) and a short **Power tools** table (network diagnostics, embedded servers, plugins,
macros, workflows, broadcast, multi-window). Mark experimental items explicitly. Keep it honest
— accurate ● / ◐ / — beats aspirational checkmarks.
