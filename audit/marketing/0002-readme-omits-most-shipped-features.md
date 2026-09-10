---
id: MKT-002
title: README Features list omits most of the shipped product (plugins, network tools, FTP, macros, multi-window, etc.)
angle: marketing / product positioning
severity: high
category: docs
is_workaround: false
subsystem: README.md
evidence:
  - README.md:73
  - docs/concepts/README.md:42
  - audit/product-completeness/_summary.md
status: open
---

## What
The README "Features" section (README.md:73–125) presents roughly a **third** of what the
product actually does. Cross-referencing the 48 *implemented* concepts and the
product-completeness feature matrix, the following shipped, user-facing capabilities are
**entirely missing** from the README:

- **Plugin system** (native ABI loader, Plugin Manager UI, code-signing / trust store) — grep `plugin` in README = 0 hits.
- **Network diagnostics suite** (ping, traceroute, port scanner, DNS lookup, HTTP monitor, Wake-on-LAN) — `network tool`/`traceroute` = 0.
- **FTP / FTPS client** as a first-class connection type + Transfer Queue — not listed as a connection type.
- **Embedded servers** (HTTP / FTP / TFTP with lifecycle management) — 0.
- **Macro recording & replay** — surfaced only as a workflow sub-step, not as its own feature.
- **Multi-window** (tear tabs into native windows) — 0.
- **Broadcast input** (synchronised input across terminals) — 0.
- **Tab groups / Workspaces** (save & restore named layouts) — workspace mentioned only in "tips".
- **Session auto-save & restore / Recent Sessions** — not surfaced.
- **SSH jump host / ProxyJump chains** — 0 (`CHANGELOG.md` markets it; README doesn't).
- **Terminal output syntax highlighting** — mentioned only inside the editor bullet.
- **Keybinding editor**, **portable mode**, **custom theme editor / Solarized**, **OS keychain / master-password credential encryption** (only "Credential storage" one-liner).

Even within the README there is internal inconsistency: the Usage-Guide "create a connection"
step (README.md:155) lists the type picker as only "Local Shell / SSH / Serial / Telnet",
omitting Docker, WSL, FTP, RDP, VNC and remote agent — which the Features section *does*
partly list.

## Why it matters
The product's core story is "**a hub** that unifies many protocols and power-user tools in one
workspace." A Features list that reads like a basic SSH/serial/telnet client actively
contradicts that story and undersells the maturity a v0.1.0 launch should be flaunting. Users
comparing against Termius (plugins, sync), MobaXterm (network tools, servers, X11) or Tabby
(plugins) can't see that termiHub matches or exceeds them, because the README never says so.
This is a discoverability failure at the exact moment a prospect decides whether to download.

## Evidence
- `README.md:73-125` — Features section; missing categories above.
- `README.md:155` — Usage-Guide connection-type list omits half the real types.
- `docs/concepts/README.md:42-92` — 48 implemented concepts covering all the above.
- `audit/product-completeness/_summary.md` — feature matrix scoring plugins, network tools,
  FTP, embedded servers, macros, multi-window, broadcast, workspaces as shipped.

## Recommendation
- Restructure Features into clear groups: **Connections** (add FTP, RDP, VNC, remote agent),
  **Power tools** (plugins, network diagnostics, embedded servers, macros, workflows),
  **Workspace** (multi-window, tab groups, workspaces, broadcast, session restore),
  **SSH depth** (jump host, tunnels, X11, SFTP, monitoring), **Customization & security**.
- Add a compact feature matrix (see MKT-006) so breadth is scannable in 10 seconds.
- Fix the README-internal connection-type list (line 155) to match the real type set.
- For each entry, be accurate about experimental gating and incomplete controls (see MKT-005).
