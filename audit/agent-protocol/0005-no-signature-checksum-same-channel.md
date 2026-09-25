---
id: AGT-005
title: Agent binaries are never signed; the checksum is served from the same channel as the binary
angle: agent-protocol
severity: high
category: security
is_workaround: false
subsystem: agent/src/update, src-tauri/src/terminal/agent_binary.rs
evidence:
  - agent/src/update/github.rs:39
  - agent/src/update/download.rs:60
  - src-tauri/src/terminal/agent_binary.rs:269
status: open
---

## What
There is no cryptographic signature, notarization, or code-signing check anywhere in the
agent update/deploy chain — searched and confirmed absent (no minisign/cosign/gpg/ed25519).
Integrity rests solely on a SHA-256 `.sha256` sidecar, and that sidecar is fetched over the
**same channel** as the binary: the self-update path resolves both the binary URL and its
`.sha256` from the same GitHub release JSON and fetches them with the same client
(`agent/src/update/github.rs:39`, `download.rs:60`); the desktop derives
`checksum_url = "{url}.sha256"` from the binary URL (`agent_binary.rs:269`).

## Why it matters
A checksum served next to the artifact only defends against corruption-in-transit and
accidental mismatch — not a coherent MITM or a compromised release, which can substitute
both files together. The binary is then executed as the agent user (and, via the update
flow, propagated host-wide). For a ventilator-grade release the artifact's *authenticity*
is never established, only its self-consistency. TLS (reqwest/rustls defaults, no pinning)
is the only authenticity control, so a CA-level compromise or an attacker-controlled update
endpoint defeats the checksum entirely.

## Evidence
- `agent/src/update/github.rs:39` — binary + sidecar URLs resolved together from one release.
- `agent/src/update/download.rs:60` — same client fetches both.
- `src-tauri/src/terminal/agent_binary.rs:269` — `checksum_url` derived from the binary URL.

## Recommendation
Sign the release digest with a key that is NOT served from the download channel (embed the
public key in the desktop/agent binaries), and verify that signature before any swap. Keep
the SHA-256 as a corruption check but do not treat it as an authenticity control.
