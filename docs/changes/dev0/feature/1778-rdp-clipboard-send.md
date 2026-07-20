### Added

- RDP: clipboard file **serving** (local→remote paste). Files placed in the
  opted-in shared folder are now advertised to the remote clipboard as a
  `FileGroupDescriptorW` list (CLIPRDR / MS-RDPECLIP), so they can be pasted into
  the RDP session; the sidecar serves each file's size and bytes on request via
  `initiate_file_copy` / `submit_file_contents`. This is the reverse of the
  receiving direction (#1765) and reuses the same opt-in and the same sandboxed
  shared folder — files are read **only** through the `crate::sandbox` resolver
  (rejecting `..` traversal, drive letters, and symlink escapes), reserved
  Windows device names and oversized files are skipped, and enumeration is
  name-sorted so an advertised index stays stable. A text copy and a file offer
  are mutually exclusive (a FormatList replaces the previous), so the most recent
  local action wins, matching a native clipboard. **View-only sessions never
  advertise or serve local files.** Bridging the host OS clipboard's native file
  list (paste any file anywhere, tied to a real paste gesture) remains a
  follow-up (#1779).
