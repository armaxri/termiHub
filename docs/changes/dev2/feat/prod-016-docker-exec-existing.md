### Added

- Docker/Podman connections can now open a shell in an **already-running
  container** instead of always starting a fresh one. A new "Container" setting
  chooses between **New container** (the default — build and run from an image,
  exactly as before) and **Existing (running) container**, where you name a
  container that is already up and termiHub simply `docker exec`s an interactive
  shell into it (PROD-016). An existing container you attach to is never stopped
  or removed when you disconnect — only auto-created containers are cleaned up.
  Targeting a container that is missing, stopped, or unreachable fails with a
  clear error rather than silently spinning up a new container.
