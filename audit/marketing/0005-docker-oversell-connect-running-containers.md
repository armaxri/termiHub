---
id: MKT-005
title: Docker feature claim oversells — "Connect to running containers" but there is no exec into a running container
angle: marketing / product positioning
severity: medium
category: docs
is_workaround: false
subsystem: README.md / core/backends/docker
evidence:
  - README.md:81
  - audit/product-completeness/0016-docker-no-exec-into-existing-container.md
status: fixed
resolution: "#2723"
---

## What
The README Docker feature reads:

> **Docker** — Connect to running containers or start new ones (README.md:81)

Per the product-completeness audit (PROD-016), the Docker backend is **run-new-only**: it can
`docker run` a fresh container, but it **cannot exec into an already-running container** — the
dominant real-world Docker workflow. The README claim "Connect to running containers" is
therefore inaccurate and would embarrass on first use: a user who reads that, then tries to
attach to their running `postgres`/`app` container, finds they cannot.

## Why it matters
This is an **oversell** on a first-use path. Marketing accuracy is a trust contract — a claim
the product can't honor on the most obvious attempt is worse than saying less. It's especially
risky because Docker is a headline connection type users will test immediately.

## Evidence
- `README.md:81` — "Connect to running containers or start new ones".
- `audit/product-completeness/0016-docker-no-exec-into-existing-container.md` — no exec into
  existing container; only run-new is supported.

## Recommendation
- Reword to match reality until exec lands, e.g. "**Docker** — Start a new container and open a
  shell in it" (drop "connect to running containers"), or
- Prioritise the exec-into-running-container capability (PROD-016) before launch so the claim
  becomes true — this is the higher-value fix, since exec is the expected Docker workflow.
- Audit the other feature bullets the same way for first-use-embarrassment claims (see MKT-006
  guidance): don't market controls that are non-functional (SFTP pause/resume — PROD-009) or
  transfer engines that are unwired (FTP — PROD-010) if/when those areas are added to the copy.
