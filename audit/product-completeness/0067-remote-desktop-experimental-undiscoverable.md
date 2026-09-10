---
id: PROD-067
title: RDP/VNC are real but hidden behind experimental features and absent from the README
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: true
subsystem: src/utils/experimentalTypes, README.md
evidence:
  - src/utils/experimentalTypes.ts:6
  - src-tauri/Cargo.toml:18
  - README.md
status: open
---

## What
VNC and RDP are complete, functional backends that ship in the default build, but they are
gated behind "Allow Experimental Features" (any `graphical` type is hidden by default). The
README's Connection Types list omits RDP/VNC entirely, so a headline capability is effectively
undiscoverable to a normal user.

## Why it matters
Substantial, working functionality (full VNC RFB client; IronRDP sidecar with clipboard, drive
redirection, audio) is invisible unless the user knows to flip an experimental toggle. For a
v0.1.0 release this is either finished work hidden by a flag, or a documentation gap — likely
both.

## Evidence
- `src/utils/experimentalTypes.ts:6-14` — graphical types hidden unless experimental on.
- `src-tauri/Cargo.toml:18` — vnc + rdp-sidecar in default features.
- `README.md` Features → Connection Types lists Local/SSH/Serial/Telnet/Docker/WSL/Remote agent; no RDP/VNC.

## Recommendation
Decide RDP/VNC release status: if release-ready, un-gate and add them to the README connection
types; if still experimental, document them as such in the README so users can discover and
opt in. (See PROD-018/19/20/21/26 for the remaining feature gaps within remote desktop.)
