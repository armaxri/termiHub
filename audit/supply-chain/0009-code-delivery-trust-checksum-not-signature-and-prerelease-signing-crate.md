---
id: SUP-009
title: Agent self-update trusts a SHA-256 checksum (no signature); plugin-signing rests on a pre-release crypto crate
angle: supply-chain
severity: medium
category: security
is_workaround: false
subsystem: agent/update
evidence:
  - agent/src/update/download.rs:1
  - agent/Cargo.toml:50
  - core/Cargo.toml:138
  - Cargo.lock:1938
status: open
---

## What

Two code-*delivery* trust chains — the paths by which termiHub obtains and runs
new executable code — rest on integrity primitives weaker than a cryptographic
signature:

1. **Agent self-update verifies a checksum, not a signature.** The optional
   agent self-updater downloads the new agent binary and verifies it against a
   `.sha256` **sidecar fetched from the same GitHub release**
   (`download_and_verify` → `verify_file_checksum`). There is no signature
   verification anywhere in `agent/src/update/` — the crate's only crypto
   dependency is `sha2`; no `ed25519`/`minisign`/`cosign`/`sigstore`. A SHA-256
   sidecar co-located with the binary proves *integrity of transit* but not
   *authenticity of origin*: anyone who can publish/replace the release assets
   (a compromised release token, a tampered mirror, a CI-artifact swap) simply
   ships a matching checksum alongside the malicious binary and the check passes.

2. **Plugin package signing — the control that gates loading arbitrary native
   `.dll`/`.so`/`.dylib` — uses a pre-release signing crate.** Plugin packages are
   Ed25519-signed (#2036) via `ed25519-dalek`, but the locked version is
   `3.0.0-pre.7` (a pre-release; see SUP-002). The security control that decides
   whether to `dlopen` untrusted native code therefore depends on unreleased
   cryptographic code.

## Why it matters

These are the highest-consequence supply-chain surfaces in the product: both end
in **arbitrary code execution** on the user's or agent host's machine. A
checksum-only update channel does not defend against a compromised release
origin — the exact threat model a signed-update scheme exists to counter — and it
is a documented weak point in the project's own framing. Basing the plugin-trust
signature on a `-pre` crate means the one cryptographic gate in front of native
plugin loading inherits SUP-002's "unreleased primitive" risk.

(The update path is off by default and the plugin system is opt-in, which bounds
blast radius — hence medium, not high — but for a safety-critical release these
are the trust chains most worth hardening.)

## Evidence

- `agent/src/update/download.rs:1-5,44-55,93` — "Download and SHA-256-verify";
  refuses an update with no published checksum, but performs no signature check.
- `agent/Cargo.toml:48-56` — update deps are `reqwest` + `semver` + `sha2` +
  `hex`; no signature-verification crate.
- `core/Cargo.toml:136-138` — plugin signing via `ed25519-dalek`;
  `Cargo.lock:1938` — `ed25519-dalek 3.0.0-pre.7`.

## Recommendation

For the agent updater: sign release binaries with a project key (minisign/cosign
or an Ed25519 detached signature) and verify the **signature**, with the public
key baked into the agent build — the checksum then only guards transit, the
signature guards origin. For plugin signing: move `ed25519-dalek` to a stable
release before relying on it as a security boundary (or pin+review it explicitly
in `deny.toml` `[bans]` like the SSH RC stack, so the trust dependency is a
reviewed decision rather than an incidental transitive `-pre`). Both are
code-execution trust anchors and warrant stable, signature-based verification for
a safety-critical release.
