---
id: CI-022
title: No SBOM, build provenance, or attestation on releases
angle: ci-cd
severity: low
category: supply-chain
is_workaround: false
subsystem: .github/workflows/release.yml
evidence:
  - .github/workflows/release.yml:463
  - .github/workflows/release.yml:93
status: open
---

## What
The release pipeline produces installers and agent binaries but emits no software bill of materials
(SBOM), no build provenance / attestation (e.g. SLSA / GitHub `actions/attest-build-provenance`), and
no signed statement binding the artifacts to the workflow run and commit. `verify-release` checks
only that expected filenames exist (`:463-538`).

## Why it matters
For a safety-critical app distributed to users, provenance and an SBOM are increasingly expected: they
let a downstream consumer verify an artifact was built by this repo's workflow from a specific commit,
and enumerate the dependency set for vulnerability response. Their absence compounds CI-008 (no
checksums/signatures) — there is currently no cryptographic link between what users download and the
source. This is a "before v1.0" maturity gap rather than a beta blocker, hence low.

## Evidence
No `attest-build-provenance`, `cyclonedx`/`syft`, or cosign step anywhere in `release.yml` /
`dev-build.yml`; the only integrity artifact is the agent `.sha256` sidecars (CI-008).

## Recommendation
Add GitHub build-provenance attestation for every released asset (`actions/attest-build-provenance`,
free, keyless), generate an SBOM (`cargo cyclonedx` for Rust + an npm SBOM) and attach it to the
release, and combine with the checksums/signing from CI-008. Schedule alongside the signing work
before v1.0.
