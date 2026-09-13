---
id: MKT-013
title: Tagline / repo description undersells product breadth (no mention of remote desktop, agents, plugins)
angle: marketing / product positioning
severity: low
category: docs
is_workaround: false
subsystem: README.md
evidence:
  - README.md:7
  - README.md:19
status: open
---

## What
The headline copy is generic and narrow:

- Tagline: "A modern, cross-platform terminal hub for managing multiple connections." (README.md:7)
- Intro sentence: enumerates "local shells, SSH, serial, telnet, Docker containers, and WSL
  distributions" (README.md:19) — but stops there, omitting the graphical remote desktop
  (RDP/VNC), remote agents, plugins, FTP, and network tools.

"Managing multiple connections" is the same claim every terminal multiplexer makes; it doesn't
convey what makes termiHub a *hub* (breadth across terminal + graphical + agents + extensibility).

## Why it matters
The tagline is the single most-read sentence (README top, GitHub repo "About" description, link
previews, package listings). A narrow tagline caps the first impression at "another SSH client"
regardless of the real breadth. This is the compressed form of the MKT-001/MKT-002 undersell,
but it deserves its own fix because it propagates to every listing surface.

## Evidence
- `README.md:7` — tagline.
- `README.md:19` — intro omits RDP/VNC, agents, plugins, FTP, network tools.

## Recommendation
- Rewrite the tagline to signal breadth and the differentiator, e.g. "One cross-platform hub for
  every remote session — terminals (SSH, serial, telnet, Docker, WSL), files (SFTP/FTP), and
  graphical desktops (RDP/VNC) — with persistent remote agents and plugins."
- Set the GitHub repo **About/description** and topics to match (they are separate surfaces from
  the README and should carry the same positioning + keywords for discoverability).
- Keep the intro paragraph's protocol list complete (add RDP/VNC, FTP, remote agents, plugins,
  network tools).
