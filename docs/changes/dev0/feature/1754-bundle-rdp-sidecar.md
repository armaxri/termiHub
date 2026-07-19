### Added

- RDP connections now ship in released desktop builds. The IronRDP sidecar
  helper (`termihub-rdp-helper`, #1747) is built and bundled next to the app via
  Tauri `externalBin`, so a shipped termiHub locates and spawns it with no manual
  `TERMIHUB_RDP_HELPER` setup. The `rdp-sidecar` desktop feature is now enabled by
  default. Like the rest of the graphical remote-desktop feature, RDP stays
  **experimental** — hidden unless "Allow Experimental Features" is enabled
  (#1705). Release and dev CI cross-build the sidecar for every shipping target
  (macOS Intel/Apple Silicon, Windows, Linux x64/arm64) (#1754).
