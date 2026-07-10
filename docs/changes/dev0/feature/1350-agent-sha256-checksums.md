### Added

- Remote agent binaries now ship a published SHA-256 checksum. Every agent
  release asset (Linux, macOS, and Windows) is accompanied by a matching
  `*.sha256` sidecar, and locally built binaries from `build-agents.sh` get one
  too. Before deploying, redeploying, or exec-replacing an agent, the desktop
  verifies the binary against its checksum on the whole resolve chain
  (cache → bundled → download). A tampered, corrupted, or mismatched binary is
  rejected with a clear error and is never installed or executed (#1350).

### Security

- Agent binary integrity is now verified with SHA-256 across all three
  platforms before any remote install, closing the gap where a substituted or
  corrupted agent binary could have been deployed unnoticed (#1350).
