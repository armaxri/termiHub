## Added

- The Docker connection editor's container picker is now Docker Compose aware: containers started by `docker compose` are grouped under their Compose project (other containers are listed last) and show their service name, and the search also matches project and service names. Works for local and agent-hosted connections. Agent protocol 0.15.0.
