### Fixed

- Docker/Podman container sessions now honour the Docker CLI's active context
  when selecting the runtime. Previously the backend connected via
  `/var/run/docker.sock` only, so on a host where a Podman install has
  symlinked that socket at its own daemon (e.g. `podman-mac-helper`), selecting
  **Docker** silently ran Podman. The backend now resolves the endpoint the
  Docker CLI would use (`DOCKER_HOST`, then the active `docker context`
  endpoint) before the default socket, verifies the daemon with a `/version`
  round-trip, and **fails loudly** with an explicit message if an explicit
  Docker selection reaches a Podman daemon. `Auto` now prefers the real Docker
  endpoint (verified by ping) and falls back to Podman only when Docker is
  genuinely unreachable, and the resolved endpoint and detected runtime are
  logged so a mismatch is diagnosable (#1600).
