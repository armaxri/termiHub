---
id: MKT2-002
title: "README presents SSH Tunnels, Network Tools and Embedded Servers as available, but they are hidden behind the experimental toggle"
angle: marketing / product positioning
severity: medium
category: docs-accuracy
is_workaround: true
subsystem: "README.md / ActivityBar experimental gating"
evidence:
  - "README.md:98"
  - "README.md:117"
  - "README.md:122-126"
  - "src/components/ActivityBar/ActivityBar.tsx:73-75"
  - "src/components/ActivityBar/ActivityBar.tsx:122-124"
  - "docs/marketing/feature-matrix.md:36-38"
  - "docs/marketing/feature-matrix.md:46-59"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Several README entries read as features that are available out of the box: SSH tunneling (README.md:98, 117), Network diagnostics and Embedded servers under 'Power Tools' (README.md:125-126). None carries an experimental marker. In the app, the only entry points to these features are the SSH Tunnels, Services and Network Tools sidebars, and they are `experimental: true` (ActivityBar.tsx:73-75). They are filtered out unless Settings → General → Allow Experimental Features is on (ActivityBar.tsx:122-124). The README labels only RDP/VNC and Workflows as experimental. The docs/marketing/feature-matrix.md draft goes further and marks tunnels, all six network tools and all three embedded servers as 'Stable'.

## Why it matters

A new user who installs because of the 'Power Tools' list will not find Network Tools, Services or Tunnels in the activity bar. The only hint is a signpost in the empty Connections list, and it disappears once a connection exists. To that user the advertised features are missing. This is the same kind of accuracy-driven trust break that MKT-005 fixed for Docker. The experimental gate is a maintainer decision (UX-002 kept it via #2762), but the README has to describe it honestly.

## Evidence

- `README.md:98`
- `README.md:117`
- `README.md:122-126`
- `src/components/ActivityBar/ActivityBar.tsx:73-75`
- `src/components/ActivityBar/ActivityBar.tsx:122-124`
- `docs/marketing/feature-matrix.md:36-38`
- `docs/marketing/feature-matrix.md:46-59`

## Recommendation

Add the same '**Experimental** — enable Settings → General → Allow Experimental Features' marker used for RDP/VNC to SSH tunneling, Network diagnostics and Embedded servers in README.md. Alternatively, group all gated features under one 'Experimental (opt-in)' subsection with a single line explaining how to enable them. Change Status to 'Experimental' for these rows in docs/marketing/feature-matrix.md. If the maintainer wants these marketed as stable, remove the gate instead; either way, the README and the gate must agree.

## Verification

Confirmed. ActivityBar.tsx:73-75 marks the tunnels, services and network-tools views experimental:true, and lines 122-124 filter them out unless experimental is on. README lines 98, 117, 125-126 have no experimental marker; only RDP/VNC carries one (line 104). feature-matrix.md marks tunnels, network tools and embedded servers 'Stable'.
