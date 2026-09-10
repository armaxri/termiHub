---
id: PLG-001
title: No published/versioned SDK crate — third parties cannot depend on the plugin ABI
angle: plugin-extensibility
severity: high
category: arch
is_workaround: false
subsystem: plugin-api
evidence:
  - plugin-api/Cargo.toml:15
  - examples/plugins/echo-backend/Cargo.toml:20
  - core/tests/fixtures/test-plugin/Cargo.toml:18
status: open
---

## What
`termihub-plugin-api` — the crate the docs call "the **stable ABI contract**
compiled into both the host and every plugin" — is marked `publish = false`, and
**every** consumer depends on it by relative path (`path = "../../../plugin-api"`).
There is no versioned artifact (crates.io, git tag, vendored release) a plugin
author *outside this monorepo* can depend on. To build a native plugin today you
must clone the whole termiHub repo and place your crate at a specific relative
depth.

## Why it matters
This is the single biggest gate on the *ecosystem* half of the plugin system. The
entire premise of a native-plugin ABI is that third parties build independent
`cdylib`s against a stable, obtainable contract. With `publish = false` and
path-only deps, the "third party" cannot obtain the contract in any supported way:
- No `termihub-plugin-api = "0.1"` from crates.io.
- No documented `git = "…", tag = "…"` dependency form.
- The example and the test fixture only work because they live *inside* the repo
  tree at a fixed relative path.

So "time to first plugin" for anyone who is not a termiHub committer is
effectively infinite through the supported path. The crate is even *independently
versioned* (`0.1.0`) and documented as the compatibility promise (`plugin-api/Cargo.toml:1-15`),
but that promise is unconsumable.

## Evidence
- `plugin-api/Cargo.toml:15` — `publish = false`, with a comment acknowledging it:
  "First-party workspace crate — not currently published to crates.io … If this
  ABI contract is ever published for third-party plugin authors, drop this…".
- `examples/plugins/echo-backend/Cargo.toml:20` — `termihub-plugin-api = { path = "../../../plugin-api" }`.
- `core/tests/fixtures/test-plugin/Cargo.toml:18` — same path form.
- `docs/plugin-authoring.md` tells authors to "Depend on this crate" but never
  shows a dependency line that resolves outside the repo.

## Recommendation
Before encouraging any external plugin development: publish `termihub-plugin-api`
to crates.io (add a real `license` field, drop `publish = false`) **or** commit to
a supported `git`+`tag` dependency form and document it in `plugin-authoring.md`
with a copy-pasteable `[dependencies]` line. Pin the crate's semver to the ABI
version discipline (see PLG-002/PLG-003) so an author can reason about
compatibility from the version they depend on. Until an obtainable SDK exists, the
native-plugin path should be described as internal-only, not an authoring contract.
