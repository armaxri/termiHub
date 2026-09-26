# npm supply chain: overrides and audit gates

This page is the tracked record for the `pnpm.overrides` block in
[`package.json`](../package.json) and for how CI audits the npm dependency tree.

## Why overrides exist

An override force-resolves a **transitive** dependency to a version its parent's declared
range would not otherwise guarantee. Every entry here exists to pull in an advisory-patched
release before the direct dependency raises its own constraint. Overrides are a workaround for
upstream lag, so each one must say what it fixes and when it can go — otherwise a stale pin
silently holds a dependency back.

Rules:

1. **Every override has a row in the table below**, and every row has an override.
   [`scripts/internal/check-pnpm-overrides.mjs`](../scripts/internal/check-pnpm-overrides.mjs)
   enforces the parity and also fails on a **dead override** — one whose target package (or
   scoped parent) no longer appears in `pnpm-lock.yaml`, i.e. it constrains nothing.
2. **Bound the range below the next major** where the major changes the module shape
   (`js-yaml` 5 dropped its default export and broke markdownlint-cli2; `undici` 8 removed the
   handler jsdom needs). Bounding keeps the fix on the advisory-patched line.
3. **Retire an override with its advisory.** When the "Removal condition" holds — the parent's
   own declared range excludes every vulnerable version, or the parent left the tree — delete the
   entry, run `pnpm install`, and confirm the lockfile's resolved versions did not move backwards
   and `pnpm audit` did not regain the advisory.

Re-deriving whether an override is still load-bearing: look up the parent's declared range
(`pnpm why <pkg>` names the parent; its `package.json` has the range). If that range can still
resolve a version below the patched floor, the override is load-bearing.

## Override register

"Parent (declared range)" is what the override is overriding, measured when the entry was last
reviewed. Every overridden package below is dev/build-time only except `dompurify`, which ships
in the app via `monaco-editor`.

| Override                      | Pin            | Parent (declared range)                                                          | Advisory                                                  | Removal condition                                             |
| ----------------------------- | -------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| `dompurify`                   | `>=3.4.12 <4`  | monaco-editor 0.55.1 (`3.2.7`, exact) — **production**                           | GHSA-cmwh-pvxp-8882, GHSA-c2j3-45gr-mqc4 and earlier XSS  | monaco-editor depends on a dompurify at or above the floor    |
| `markdown-it`                 | `>=14.2.0 <15` | markdownlint-cli2 0.22.1 (`14.1.1`, exact)                                       | GHSA-6v5v-wf23-fmfq (smartquotes DoS)                     | markdownlint-cli2 depends on markdown-it >=14.2.0             |
| `js-yaml`                     | `>=4.2.0 <5`   | @eslint/eslintrc (`^4.1.1`), cosmiconfig (`^4.1.0`), markdownlint-cli2 (`4.1.1`) | GHSA-h67p-54hq-rp68 (merge-key DoS)                       | every parent's range starts at or above the floor             |
| `flatted`                     | `>=3.4.2`      | flat-cache 4.0.1 (`^3.2.9`), via eslint                                          | GHSA-rf6f-7fwh-wjgh, GHSA-25h7-pfq9-p65f                  | flat-cache requires flatted >=3.4.2                           |
| `fast-uri`                    | `>=3.1.2`      | ajv 8.18.0 (`^3.0.1`), via commitlint                                            | GHSA-v39h-62p7-jpjc, GHSA-q3j6-qgpj-74h6                  | ajv requires fast-uri >=3.1.2                                 |
| `rollup`                      | `>=4.59.0`     | vite 6.4.3 (`^4.34.9`)                                                           | GHSA-mw96-cpmx-2vgc (path-traversal file write)           | vite requires rollup >=4.59.0                                 |
| `postcss`                     | `>=8.5.10`     | vite 6.4.3 (`^8.5.3`)                                                            | GHSA-qx2v-qp2m-jg93 (XSS in stringify)                    | vite requires postcss >=8.5.10                                |
| `undici`                      | `>=7.28.0 <8`  | jsdom 28.1.0 (`^7.21.0`)                                                         | GHSA-vxpw-j846-p89q, GHSA-p88m-4jfj-68fv and the 7.24 set | jsdom requires undici >=7.28.0                                |
| `vite>picomatch`              | `>=4.0.4`      | vite 6.4.3 (`^4.0.2`)                                                            | GHSA-c2c7-rcm5-vvqj (ReDoS), GHSA-3v7f-55p6-f55p          | vite requires picomatch >=4.0.4                               |
| `vitest>picomatch`            | `>=4.0.4`      | vitest 4.1.7 (`^4.0.3`)                                                          | GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p                  | vitest requires picomatch >=4.0.4                             |
| `micromatch>picomatch`        | `2.3.2`        | micromatch 4.0.8 (`^2.3.1`)                                                      | GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p                  | micromatch requires picomatch >=2.3.2                         |
| `minimatch@3>brace-expansion` | `1.1.14`       | minimatch 3.1.5 (`^1.1.7`), via eslint                                           | GHSA-f886-m6hf-6m8v (zero-step hang)                      | minimatch 3 requires brace-expansion >=1.1.14, or leaves tree |

Removed in #3477 because their target left the dependency tree entirely (the lockfile's
resolved graph was unchanged by the removal): `serialize-javascript` (its mocha parent is gone),
`anymatch>picomatch` and `readdirp>picomatch` (no chokidar 3 left), and
`minimatch@5>brace-expansion` (no minimatch 5 left).

## Audit gates

The npm audit runs in the **Security Audit** workflow
([`.github/workflows/security-audit.yml`](../.github/workflows/security-audit.yml)), which
runs on pull requests that change a dependency manifest or lockfile, on every push to
`develop`/`main` (post-merge), and daily (#3325/#3326 lane policy).

- **Production tree — blocking.**
  [`scripts/internal/pnpm-audit-prod-gate.sh`](../scripts/internal/pnpm-audit-prod-gate.sh)
  runs `pnpm audit --prod` and fails on any high or critical advisory in the code that ships in
  the app. It soft-passes only when the registry is unreachable (#2589), never on a real
  advisory.
- **Full tree (incl. devDependencies) — advisory.** Dev/build tooling does not ship, so a
  dev-only advisory does not block unrelated PRs. The step still writes a per-severity count to
  the job summary and raises a warning annotation when any high or critical advisory is present,
  so it is visible without reading the log. Fix it by bumping the tool or adding/raising an
  override (with a row above).
