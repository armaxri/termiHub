### Added

- RDP: clipboard bridging. Text copied on an RDP desktop now transfers both
  ways over the clipboard redirection channel (CLIPRDR / MS-RDPECLIP) in the
  IronRDP sidecar. A remote copy is mirrored to the local clipboard panel, and
  the local clipboard is offered to the remote (Unicode preferred, ANSI as a
  fallback). View-only sessions never push the local clipboard to the remote.
  The RDP backend now advertises `supports_clipboard` (#1756).
