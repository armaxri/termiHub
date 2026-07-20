### Added

- RDP: paste **any local file** into the remote session, not just files staged
  in the shared folder. On **macOS**, the sidecar now reads the host OS
  clipboard's native file list (`NSPasteboard` file URLs) and offers those real
  files to the remote over CLIPRDR, so a file copied in Finder can be pasted into
  the RDP session (#1779). The host clipboard takes precedence over the shared
  folder — most recent local action wins, matching a native client — and files
  are served read-only from their real paths, regular files only, size-capped;
  the remote only ever selects an advertised index, so it can never coax the
  sidecar into serving a file the user did not copy. Gated behind the same opt-in
  as clipboard file transfer (#1778), and **view-only sessions never advertise or
  serve host-clipboard files.** Windows (`CF_HDROP`) and Linux (`text/uri-list`)
  host-clipboard reading, and tying a remote→local download to a real local paste
  (delayed rendering), are sequenced follow-ups.
