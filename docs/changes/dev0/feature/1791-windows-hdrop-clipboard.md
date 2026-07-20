### Added

- RDP on **Windows**: paste **any file copied in Explorer** into the remote
  session, not just files staged in the shared folder. The sidecar now reads the
  Windows clipboard's native `CF_HDROP` file list and offers those real files to
  the remote over CLIPRDR, mirroring the macOS host-clipboard bridge (#1779). This
  completes the Windows half of #1779: a file copied in Explorer is served to the
  remote read-only from its real path, regular files only, size-capped, with the
  remote only ever selecting an advertised index — it can never coax the sidecar
  into serving a file the user did not copy. Gated behind the same opt-in as
  clipboard file transfer (#1778), and **view-only sessions never advertise or
  serve host-clipboard files.** Linux (`text/uri-list`) host-clipboard reading
  remains a sequenced follow-up. (#1791, follow-up to #1779)
