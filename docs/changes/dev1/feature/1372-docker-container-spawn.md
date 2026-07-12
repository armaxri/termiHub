### Added

- Docker/Podman "new container" spawn with a bind-mounted directory (SI-1 of the
  shell context-menu integration epic, #1363). A spawn request for a new
  container now resolves to a container that bind-mounts the target host
  directory at `/workspace` (mount target and image are configurable via
  `--container-mount` / `--container-image`, defaulting to `/workspace` and a
  standard base image), opens an interactive shell already `cd`'d into the
  mount, and — on close — **stops but does not remove** the container so it can
  be restarted or inspected. A file location resolves to its parent directory.
  Spawned containers are tracked separately from configured Docker connections
  and surfaced with a "Spawned" tab title marker. A new
  `resolve_container_spawn` command exposes the resolution to the app. The
  interactive picker that chooses "new container" lands separately (#1363, SI-3).
