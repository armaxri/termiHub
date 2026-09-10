---
id: SEC-006
title: Agent self-update authenticates binaries with a same-origin SHA-256 checksum, not a signature
angle: security
severity: medium
category: supply-chain
is_workaround: false
subsystem: agent/src/update
evidence:
  - agent/src/update/download.rs:1
  - agent/src/update/download.rs:47
  - agent/src/update/download.rs:75
status: open
---

## What

The optional agent self-update downloads a replacement agent binary from GitHub
releases and verifies it against a `.sha256` **checksum sidecar fetched from the
same release** — there is no cryptographic signature over the binary:

```rust
// agent/src/update/download.rs:1-4
//! Download and SHA-256-verify an agent binary for a self-update.
//! release binary is only staged if it is accompanied by a matching `.sha256`
```
```rust
// agent/src/update/download.rs:47-88
pub async fn download_and_verify(...) {
    let checksum_url = match urls.checksum_url.as_deref() { ... }; // from same release
    download_to_file(client, &urls.binary_url, dest).await ...;
    verify_downloaded(client, checksum_url, dest, &sidecar).await; // sha256 compare
}
```

A checksum fetched from the same channel as the artifact provides **integrity**
(detects corruption) but **not authenticity**: anyone able to publish/replace the
release assets — a compromised GitHub token/account, a malicious maintainer, a
release-pipeline compromise, or a TLS-terminating proxy on the agent host's
egress — can supply a malicious binary *and* a matching `.sha256`, and the agent
will stage and run it.

## Why it matters

The agent executes shell/SSH/Docker sessions on the remote host; a subverted
agent binary is remote code execution on every host running it. For a
safety-critical release, code that auto-replaces an executable must verify a
signature made with a key the release channel cannot itself produce. It is off by
default (`allow_self_update`), which bounds exposure — but any operator who
enables auto-update inherits full trust in the GitHub release channel with no
second factor, and there is no visible **downgrade protection** (a valid older
signed/checksummed release could be served to roll the agent back to a
known-vulnerable version).

## Evidence

- `agent/src/update/download.rs:1-4`, `:41-47`, `:74-88` — SHA-256 sidecar is the
  only integrity/authenticity gate; no `minisign`/ed25519/cosign verification.
- Contrast: the *desktop* update is notify-only (`src-tauri/src/commands/update.rs`
  returns a release URL, does not auto-install), so this risk is specific to the
  agent's self-update path.

## Recommendation

Sign agent release binaries with an offline key (e.g. minisign / ed25519 /
Sigstore) whose public half is compiled into the agent, and verify the signature
before staging — the checksum can stay as a cheap pre-check but must not be the
trust anchor. Add monotonic **downgrade protection** (refuse a version lower than
the running one unless an explicit rollback is requested). Keep the feature
off-by-default and document that enabling it trusts the signing key. This aligns
with the release-strategy note that binary signing is currently deferred — the
agent self-update path is where deferring it has the highest impact.
