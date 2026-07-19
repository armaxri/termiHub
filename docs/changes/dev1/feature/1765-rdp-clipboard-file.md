### Added

- RDP: clipboard file receiving. When files are copied to the clipboard on an
  RDP desktop, they can now be downloaded to the local machine over the
  clipboard file-transfer PDUs (CLIPRDR / MS-RDPECLIP `FileGroupDescriptorW` +
  File Contents Request/Response) in the IronRDP sidecar. It is **off by
  default** and opt-in per connection via the new "Receive Clipboard Files"
  option, which requires drive redirection (#1757): received files land only in
  that already-shared folder, so the remote gains no new local access. Every
  destination is sandboxed against `..` traversal, drive letters, and symlink
  escapes; Windows reserved device names are rejected; colliding names are
  deduplicated; and oversized files are skipped. The bridge only receives files,
  so view-only sessions are unaffected. Serving local files to the remote and
  bridging the host OS clipboard's native file list are tracked as follow-ups
  (part of #1765).
