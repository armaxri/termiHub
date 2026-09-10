---
id: MKT-014
title: Trust signals underused — security posture not sold, and unsigned-beta warning lacks the "why / it's safe" reassurance
angle: marketing / trust & credibility
severity: low
category: docs
is_workaround: false
subsystem: README.md / SECURITY.md
evidence:
  - README.md:64
  - README.md:106
  - SECURITY.md:1
status: open
---

## What
Two trust-signaling gaps for a safety-critical connection manager:

1. **Security posture is not used as a selling point.** termiHub has genuine trust
   differentiators — credential encryption with OS keychain / Argon2id+AES-GCM master-password
   backends, local-only/no-telemetry operation, plugin code-signing, a solid SECURITY.md
   disclosure policy. In the README these appear only as a two-line "Security" feature block
   (README.md:106–109); the credibility story ("your credentials are encrypted, nothing phones
   home, plugins are signed") is never told.

2. **The unsigned-beta warning sets expectations but not reassurance.** The README honestly
   documents the Gatekeeper/SmartScreen friction and the per-OS steps (README.md:25, 64–69) —
   which is good and above-average. But it never explains **why** the app is unsigned (no paid
   signing certificate yet for a pre-1.0 community project) or reassures that bypassing the
   warning is expected and safe here. A user hitting "unrecognized/unidentified developer" with
   no rationale may abandon the install, reading it as a red flag rather than a known beta
   limitation.

## Why it matters
For a tool that holds SSH keys, passwords and opens remote sessions, trust *is* the pitch.
Under-selling the real security work loses a differentiator; under-explaining the unsigned
warning creates install-time churn and can read as untrustworthy — the opposite of the truth.

## Evidence
- `README.md:64-69` — unsigned-beta steps; no "why unsigned / it's safe" rationale.
- `README.md:106-109` — thin two-line Security feature block.
- `SECURITY.md` — strong disclosure policy, not referenced from the README shopfront.

## Recommendation
- Add a short **"Security & privacy"** blurb near the top: encrypted credential store (keychain
  / master password), local-only / no telemetry, signed plugins — with a link to `SECURITY.md`.
- In the unsigned-beta note, add one sentence on **why** (no code-signing cert for the pre-1.0
  beta; signing/notarization is planned — the backlog concepts exist) and that bypassing the OS
  warning is expected for this beta. Keeps expectation-setting honest *and* reassuring.
- Link `SECURITY.md` from the README Documentation section.
