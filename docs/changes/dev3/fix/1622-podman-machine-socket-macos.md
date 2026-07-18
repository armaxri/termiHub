### Fixed

- Docker/Podman: selecting **runtime: Podman** on macOS now connects to the running
  Podman machine instead of failing with "Could not determine Podman socket path". On
  macOS Podman runs in a VM whose Docker-compatible API socket lives at a per-user path
  under `$TMPDIR` (`…/T/podman/podman-machine-default-api.sock`), which none of the
  previously checked locations matched. The socket is now resolved there (preferring the
  default machine, falling back to any single machine socket). The Linux/rootless native
  socket paths are unchanged, and when no machine is running the error now points to
  `podman machine start` (#1622).
