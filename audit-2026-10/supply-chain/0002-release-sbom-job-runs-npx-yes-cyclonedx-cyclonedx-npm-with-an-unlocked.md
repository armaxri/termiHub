---
id: SUP2-002
title: "Release SBOM job runs `npx --yes @cyclonedx/cyclonedx-npm` with an unlocked transitive tree and install scripts, under contents:write + id-token:write + attestations:write"
angle: supply-chain
severity: medium
category: supply-chain
is_workaround: false
subsystem: "release / sbom"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - .github/workflows/release.yml:994
  - .github/workflows/release.yml:998
  - .github/workflows/release.yml:999
  - .github/workflows/release.yml:1000
  - .github/workflows/release.yml:1001
  - .github/workflows/release.yml:1039
  - .github/workflows/release.yml:1049
  - .github/workflows/release.yml:1065
---

## What

The sbom job pins only the top-level package version (CYCLONEDX_NPM_VERSION 6.0.1) and fetches it with `npx --yes`. npx resolves the tool's whole dependency tree from the registry at run time with no lockfile and no integrity pinning, and npm runs dependency lifecycle scripts by default. This is the only place in CI that installs npm code outside pnpm-lock.yaml; every other install uses `pnpm install --frozen-lockfile --ignore-scripts` plus onlyBuiltDependencies. The job holds `contents: write` (release asset upload and repo writes), `id-token: write` and `attestations: write`. The same job then signs SLSA provenance over the SBOMs it generated (:1062-1065).

## Why it matters

A compromised or typosquatted transitive dependency of cyclonedx-npm (a classic npm worm vector) would execute inside the release workflow. With the job's token it could tamper with or replace release assets. It could also mint Sigstore build-provenance attestations for arbitrary artifacts as this repo's release workflow, which defeats the `gh attestation verify` trust that release.yml:683-689 advertises to users. None of the project's npm gates (frozen lockfile, prod audit, override register) cover this tree.

## Recommendation

Install the tool from a committed lock: add @cyclonedx/cyclonedx-npm as a pinned devDependency (so pnpm-lock.yaml integrity and the audits cover it) and run it via `pnpm exec`. Alternatively, keep a tools-only lockfile and run `npm ci --ignore-scripts`. Separately, split the job: generate the SBOMs in a job with `contents: read` and no id-token, upload them as an artifact, and attest and upload in a minimal privileged job that runs no third-party code.

## Verification

Confirmed at release.yml ~1036. The job runs `npx --yes @cyclonedx/cyclonedx-npm@6.0.1`, which pins only the top-level version. Its transitive tree is resolved live with no lockfile or integrity pin, and npm runs lifecycle scripts by default. The job holds contents:write, id-token:write and attestations:write, then attests over the output. Every other npm install in CI is frozen-lockfile with --ignore-scripts, so this is the one ungated npm code path, and it runs in a privileged release job. Exploitation needs a compromised upstream dependency, but the impact is high (tampered assets, forged provenance), so medium stands.
