### Added

- RDP: drive redirection. A single local folder can now be shared with an RDP
  session as a mapped drive over the device-redirection channel (RDPDR /
  MS-RDPEFS) in the IronRDP sidecar. The remote can browse, read, and write the
  files in that folder — open/create, read, write, directory listing, rename,
  delete, and truncate are all served. Redirection is **off by default** and
  opt-in per connection via the new "Redirect a Local Drive", "Shared Folder",
  and "Drive Name" options; only the selected folder is exposed (never the whole
  filesystem), and every path the server requests is sandboxed against `..`
  traversal, drive letters, and symlink escapes. The drive appears in the remote
  session as "&lt;Drive Name&gt; on termiHub" (#1757).
