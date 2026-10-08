---
id: DOC2-004
title: "README presents SSH tunnels, network tools and embedded servers as plain features, but they are hidden behind the experimental toggle"
angle: docs-accuracy
severity: low
category: missing-caveat
is_workaround: false
subsystem: "README"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - README.md:19
  - README.md:117
  - README.md:125-126
  - README.md:204
  - src/components/ActivityBar/ActivityBar.tsx:73-76
  - src/components/ActivityBar/ActivityBar.tsx:127
  - src/hooks/useExperimentalFeatures.ts:13-14
---

## What

ActivityBar.tsx:73-75 marks the SSH Tunnels, Services (embedded servers) and Network Tools views `experimental: true`, and line 127 hides them unless experimentalFeaturesEnabled is on (default false, useExperimentalFeatures.ts:14). The README lists SSH tunneling (lines 19, 117), network diagnostics (line 125) and embedded HTTP/FTP/TFTP servers (line 126) as ordinary features. It marks only RDP/VNC and Workflows as experimental. The Interface Overview (line 204) also describes an Activity Bar with only Connections, File Browser and a gear. The real bar also has Recent Sessions, Workspaces, Macros, Plugins and Log Viewer, plus the four experimental views.

## Why it matters

On a default install a user cannot find three of the advertised features and gets no hint about the Settings → General → Allow Experimental Features toggle. The README already gives that hint for RDP/VNC and Workflows, so the treatment is inconsistent.

## Recommendation

Tag SSH tunneling, Network diagnostics and Embedded servers as experimental in the README feature list, with the same "enable Settings → General → Allow Experimental Features" note used for RDP/VNC. Update the Activity Bar description at README.md:204 to list the current views. If the maintainer intends these to be stable for 0.1.0, remove the `experimental` flag in ActivityBar.tsx instead.

## Verification

Confirmed. ActivityBar.tsx marks tunnels, services and network-tools as experimental: true, and the filter hides them unless experimentalFeaturesEnabled is on (default false). README lists them as normal features, and its Activity Bar description at :204 names only Connections and File Browser. Lowered to low: this is a discoverability and docs gap, not a correctness or safety problem.
