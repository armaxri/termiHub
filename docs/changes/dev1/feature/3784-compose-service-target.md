### Added

- Docker: a new **Compose service** container mode lets a connection target a Docker Compose
  service as `project/service` instead of a generated container name. At connect time termiHub
  resolves it to the service's running container by its Compose labels, so a
  `docker compose up --force-recreate` or a scale change no longer breaks the saved connection.
  With several running replicas the lowest-numbered one is used; if none is running the
  connection fails with a "not found" error and a hint. The connection editor's picker lists
  the Compose services to choose from. Works for local and agent-hosted connections (#3784).
