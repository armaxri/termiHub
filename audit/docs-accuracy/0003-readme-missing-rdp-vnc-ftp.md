---
id: DOC-003
title: README omits shipped connection types (RDP, VNC, FTP) that ship enabled-by-default
angle: docs-accuracy
severity: high
category: docs
is_workaround: false
subsystem: README/connection-types
evidence:
  - README.md:75
  - README.md:168
  - CHANGELOG.md:19
  - src-tauri/Cargo.toml:18
  - src-tauri/src/session/registry.rs:96
  - src/utils/experimentalTypes.ts:11
status: fixed
resolution: "#2723"
---

## What

The README's "Connection Types" feature list (README.md:75-83) and the Usage-guide connection
list (README.md:168-173) enumerate Local, SSH, Serial, Telnet, Docker, WSL, and Remote agent —
but omit **RDP**, **VNC**, and **FTP**, all of which are shipped connection types compiled in by
default. The project's own CHANGELOG for 0.1.0 lists them as headline features ("SFTP/FTP file
transfer … and remote-desktop (VNC/RDP) connections"), so the README under-describes the released
product.

## Why it matters

Users reading the README will not know termiHub can do RDP/VNC remote-desktop or FTP at all.
For remote-desktop especially there is a first-run subtlety (it is hidden until the user enables
**Allow Experimental Features**), so a user could conclude the feature doesn't exist. This is a
user-facing completeness gap on the primary landing document, and it disagrees with the CHANGELOG.

## Evidence

- README connection-type lists (README.md:75-83, 168-173) contain no RDP/VNC/FTP.
- CHANGELOG.md:19 (the `[0.1.0]` summary) explicitly ships "SFTP/**FTP** file transfer, embedded
  servers, network diagnostics, and **remote-desktop (VNC/RDP)** connections".
- Backends are compiled by default: `src-tauri/Cargo.toml:18` `default = ["ftp",
  "mock-remote-desktop", "vnc", "rdp-sidecar"]`.
- Registered as real connection types: `src-tauri/src/session/registry.rs:96-116` (VNC → `vnc`,
  RDP → `rdp`); FTP backend in `core/src/backends/ftp/`.
- VNC/RDP are gated behind the existing experimental-features flag (shown only when
  `capabilities.graphical === true`): `src/utils/experimentalTypes.ts:11-53`,
  `src/components/ConnectionEditor/ConnectionEditor.tsx:554-568`.

## Recommendation

Add RDP and VNC (as **experimental**, noting the "Allow Experimental Features" gate and that RDP
uses a bundled `termihub-rdp-helper` sidecar) and FTP to both README connection-type lists. If
remote-desktop is intentionally not being promoted for the beta, say so explicitly rather than
omitting it — the CHANGELOG already advertises it, so silence in the README is a contradiction.
