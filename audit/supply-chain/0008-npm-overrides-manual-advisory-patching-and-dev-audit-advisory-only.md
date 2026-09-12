---
id: SUP-008
title: npm supply-chain leans on ~20 manual override pins; dev-dependency audit is advisory-only
angle: supply-chain
severity: low
category: supply-chain
is_workaround: true
subsystem: package.json
evidence:
  - package.json:68
  - .github/workflows/code-quality.yml:300
  - .github/workflows/code-quality.yml:309
status: open
---

## What

`package.json` carries a large `pnpm.overrides` block (~20 entries) that forces
transitive dependency versions. Several are clearly **security-advisory
mitigations** pinned by hand: `dompurify >=3.4.12` (XSS), `undici >=7.28.0`,
`markdown-it >=14.2.0`, `serialize-javascript >=7.0.5`, `postcss >=8.5.10`,
`fast-uri >=3.1.2`, `js-yaml >=4.2.0`, and multiple `brace-expansion` /
`picomatch` pins. This is transitive-vulnerability patching baked into the
manifest.

Separately, the CI audit split gates only the **production** tree
(`pnpm-audit-prod-gate.sh`, blocking on high+critical), while the **full-tree**
audit that includes devDependencies runs `continue-on-error: true` — advisory
only, never gating.

## Why it matters

Two maintainability/coverage concerns, both low-severity but real:

- **The override block is brittle and unowned.** Each entry is a manual response
  to a past advisory. Nothing prunes them when the direct dependency catches up
  (they become dead constraints) and nothing refreshes them when a *new* advisory
  lands on a *different* transitive crate — that relies on a human re-running
  `pnpm audit` and editing the manifest. Manual advisory-pinning drifts stale and
  gives a false sense of coverage.

- **Dev-dependency advisories never gate.** The `--prod` scoping is a reasonable
  choice (dev/build tooling does not ship to users), and it is well justified in
  the workflow comments. But a compromised or vulnerable build-time dependency is
  a supply-chain attack vector in its own right (it runs on developer and CI
  machines with repo access). Making it strictly advisory means a high-severity
  dev-tool advisory produces only a log line.

## Evidence

- `package.json:68-86` — the `pnpm.overrides` block; note the security-shaped
  pins (dompurify, undici, markdown-it, serialize-javascript, postcss,
  brace-expansion, fast-uri).
- `.github/workflows/code-quality.yml:300-301` — blocking prod gate.
- `.github/workflows/code-quality.yml:309-311` — full-tree audit
  `continue-on-error: true` ("Dev-only advisories: warn, do not fail").
- Positive: `pnpm.onlyBuiltDependencies: ["esbuild"]` (package.json:87-89)
  correctly restricts postinstall build scripts to a single vetted package —
  good posture against malicious lifecycle scripts.

## Recommendation

(1) Add a periodic job (or fold into the existing weekly chore pattern) that
re-derives which overrides are still load-bearing vs. satisfied-by-upstream, and
flags stale ones for removal, so the block does not calcify. (2) Keep the prod
gate blocking, but promote the full-tree dev audit from silent
`continue-on-error` to a job that at least annotates the PR summary with a
high/critical count and requires an explicit ack to merge — a middle ground
between "advisory log line" and "blocks unrelated PRs". (3) Document, next to the
override block, why each entry exists (advisory ID) so a future maintainer can
tell a security pin from a compatibility pin.
