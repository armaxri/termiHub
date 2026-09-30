### Security

- The RDP sidecar integrity check now hashes and launches the helper through a
  single pinned file handle, closing the remaining window in which the verified
  file could be swapped between the check and the launch. Linux executes the
  hashed file by descriptor, Windows holds the file write/delete-locked across the
  launch, and macOS (which has no descriptor-based exec) refuses to continue if
  the file's identity changed around the launch. On every platform the file is
  re-verified after launch, before any credentials are sent (#2835).
