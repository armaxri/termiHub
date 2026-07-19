### Added

- **RDP remote-desktop backend (experimental, foundational slice, #1747).** RDP
  now decodes through a separately-built **IronRDP sidecar** — the
  `termihub-rdp-helper` binary — which sidesteps the russh ↔ IronRDP dependency
  conflict (#1725) by living in a workspace-excluded crate with its own
  `Cargo.lock`. The desktop's new `SidecarRdp` backend spawns and supervises the
  helper per session and bridges its IPC into the existing shared remote-desktop
  layer (#1680), so the entire canvas/toolbar/input/clipboard frontend is reused
  untouched. Connect (TLS/NLA), framebuffer decode, and keyboard/pointer/wheel
  input work; the shared connection editor gains an **RDP** type (host, port,
  domain, security mode, certificate handling). Gated behind the `rdp-sidecar`
  build feature and, at runtime, experimental features (#1705); the helper is
  built with `scripts/build-rdp-sidecar.sh`. Dynamic resize, CLIPRDR clipboard,
  drive redirection, audio, and cross-platform release bundling are sequenced
  follow-ups.
