---
id: WA-CI-015
title: .cargo/config.toml disables HTTP/2 multiplexing + bumps retries to dodge crates.io flake
angle: workaround-ci-scripts
severity: low
category: workaround
is_workaround: true
subsystem: .cargo
evidence:
  - .cargo/config.toml
status: open
---

## What
`.cargo/config.toml` sets `[http] multiplexing = false` and `[net] retry = 5` repo-wide to work
around transient `curl [16] Error in the HTTP2 framing layer` failures downloading crates from
`static.crates.io` (#897). Forcing HTTP/1.1 avoids the HTTP/2 framing error; the retry bump
covers general transient failures.

## Why it matters
This is a network-hardening workaround for an upstream/crates.io transport flake, committed at
repo level so it also slows every local and CI build (HTTP/1.1 = no connection multiplexing =
slower cold dependency fetches). Low blast radius, but it is a permanent global degradation
applied to route around a transient class of failures that may no longer occur.

## Evidence
`multiplexing = false` and `retry = 5` with the #897 rationale comment.

## Recommendation
Periodically test whether the HTTP/2 framing flake still reproduces (curl/crates.io CDN have
moved on since #897); if not, re-enable multiplexing to restore fetch speed and keep only the
`retry = 5` bump. Low priority; not release-blocking.
