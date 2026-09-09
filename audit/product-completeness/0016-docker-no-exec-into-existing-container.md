---
id: PROD-016
title: Docker connections always run a NEW container; cannot exec into a running one
angle: product-completeness
severity: high
category: missing-feature
is_workaround: false
subsystem: core/backends/docker
evidence:
  - core/src/backends/docker/mod.rs:365
  - core/src/backends/docker/mod.rs:423
status: open
---

## What
The Docker backend requires an image, generates a new container name, runs a fresh container,
and removes it on exit. There is no option to `docker exec` into an existing/running container.

## Why it matters
The overwhelmingly common Docker workflow is "shell into my already-running container"
(`docker exec -it <container>`). termiHub only does `docker run`, so the primary use case is
unsupported — a significant gap for the advertised Docker connection type.

## Evidence
- `core/src/backends/docker/mod.rs:365-391` — `generate_container_name`, `remove_on_exit`.
- schema `:423-605` — only `image`, no container-name/attach field.

## Recommendation
Add an "attach to existing container" mode: list running containers (see PROD-017) or accept
a container name/id and `docker exec` into it, with the run-new-container mode as an alternative.
