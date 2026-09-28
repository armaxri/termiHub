---
id: PROD-017
title: No Docker container listing/discovery or compose awareness
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: core/backends/docker
evidence:
  - core/src/backends/docker/mod.rs:365
status: partial
resolution: "#3426, #3765 — docker container picker local (#3426) + agent-hosted via docker.list_containers RPC, old agents fall back to typed field (#3765, protocol 0.14.0). Remaining: compose project/service awareness #3425"
---

## What
There is no `docker ps`-style listing to pick a running container, and no docker-compose
project awareness.

## Why it matters
Without discovery, users must know exact image/container names; there is no way to browse what
is running. Compose-project awareness is expected for multi-container dev setups.

## Evidence
- No list/ps/compose commands anywhere in `core/src/backends/docker/`.

## Recommendation
Add a `list_containers` capability surfaced as a picker in the Docker connection editor, and
optionally list compose projects/services.
