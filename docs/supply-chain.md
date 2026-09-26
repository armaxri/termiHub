# Supply chain: overrides, audit gates, vendored forks and parser watchlist

This page is the tracked record for the `pnpm.overrides` block in
[`package.json`](../package.json), for how CI audits the dependency trees, for the in-tree
forks of third-party crates ([Vendored forks](#vendored-forks)) and for the crates that parse
untrusted remote input ([Untrusted-input parser watchlist](#untrusted-input-parser-watchlist)).

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
reviewed. Every overridden package below is dev/build-time only.

| Override                      | Pin            | Parent (declared range)                                                                             | Advisory                                                                                                            | Removal condition                                             |
| ----------------------------- | -------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `markdown-it`                 | `>=14.2.0 <15` | markdownlint-cli2 0.22.1 (`14.1.1`, exact)                                                          | GHSA-6v5v-wf23-fmfq (smartquotes DoS)                                                                               | markdownlint-cli2 depends on markdown-it >=14.2.0             |
| `js-yaml`                     | `>=4.3.2 <5`   | @eslint/eslintrc 3.3.7 (`^4.3.2`), cosmiconfig 9.0.1 (`^4.1.0`), markdownlint-cli2 0.22.1 (`4.1.1`) | GHSA-h67p-54hq-rp68, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh                                                       | every parent's range starts at or above the floor             |
| `flatted`                     | `>=3.4.2`      | flat-cache 4.0.1 (`^3.2.9`), via eslint                                                             | GHSA-rf6f-7fwh-wjgh, GHSA-25h7-pfq9-p65f                                                                            | flat-cache requires flatted >=3.4.2                           |
| `fast-uri`                    | `>=3.1.6 <4`   | ajv 8.18.0 (`^3.0.1`), via commitlint                                                               | GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp and earlier                                           | ajv requires fast-uri >=3.1.6                                 |
| `rollup`                      | `>=4.59.0`     | vite 6.4.3 (`^4.34.9`)                                                                              | GHSA-mw96-cpmx-2vgc (path-traversal file write)                                                                     | vite requires rollup >=4.59.0                                 |
| `postcss`                     | `>=8.5.23`     | vite 6.4.3 (`^8.5.3`)                                                                               | GHSA-qx2v-qp2m-jg93, GHSA-r28c-9q8g-f849, GHSA-fxqj-rqcc-2cmp                                                       | vite requires postcss >=8.5.23                                |
| `undici`                      | `>=7.29.0 <8`  | jsdom 28.1.0 (`^7.21.0`)                                                                            | GHSA-4cwx-7wf7-3272, GHSA-8xcm-r25x-g524, GHSA-m8rv-5g2x-5cg5, GHSA-jr45-8vmc-qm54, GHSA-v3r7-h72x-cjcm and earlier | jsdom requires undici >=7.29.0                                |
| `vite>picomatch`              | `>=4.0.4`      | vite 6.4.3 (`^4.0.2`)                                                                               | GHSA-c2c7-rcm5-vvqj (ReDoS), GHSA-3v7f-55p6-f55p                                                                    | vite requires picomatch >=4.0.4                               |
| `vitest>picomatch`            | `>=4.0.4`      | vitest 4.1.11 (`^4.0.3`)                                                                            | GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p                                                                            | vitest requires picomatch >=4.0.4                             |
| `micromatch>picomatch`        | `2.3.2`        | micromatch 4.0.8 (`^2.3.1`)                                                                         | GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p                                                                            | micromatch requires picomatch >=2.3.2                         |
| `minimatch@3>brace-expansion` | `>=1.1.18 <2`  | minimatch 3.1.5 (`^1.1.7`), via eslint                                                              | GHSA-f886-m6hf-6m8v, GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895                                  | minimatch 3 requires brace-expansion >=1.1.18, or leaves tree |
| `smol-toml`                   | `>=1.7.1 <2`   | markdownlint-cli2 0.22.1 (`1.6.1`, exact)                                                           | GHSA-7w5x-hrqm-74c2 (malformed-TOML DoS)                                                                            | markdownlint-cli2 depends on smol-toml >=1.7.1                |

Removed in #3477 because their target left the dependency tree entirely (the lockfile's
resolved graph was unchanged by the removal): `serialize-javascript` (its mocha parent is gone),
`anymatch>picomatch` and `readdirp>picomatch` (no chokidar 3 left), and
`minimatch@5>brace-expansion` (no minimatch 5 left).

Removed in #3482: `dompurify` — monaco-editor 0.57.0 pins DOMPurify 3.4.15 exactly, above the
GHSA-55q2-fjhq-7xh7 fix (3.4.13), so the production tree no longer needs the override.

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

## Vendored forks

Two third-party crates are carried as in-tree forks (SUP-005). A fork is consumed by **path** or
by **`[patch.crates-io]`**, so `cargo update`, Dependabot, `cargo audit` and `cargo deny` never
see the upstream crate again: an upstream security fix is not pulled in and a RustSec advisory
against the upstream crate is not reported. Both forks sit on untrusted-input paths, so the
upstream crate is watched explicitly instead.

| Fork                                | Upstream                                                                              | Base                            | Reviewed up to           | Why it is forked                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `vendor/vnc-rs`                     | [HsuJv/vnc-rs](https://github.com/HsuJv/vnc-rs)                                       | 0.5.3 (`f8ac0ee`)               | 0.6.0 (`99ed1a2`, #3499) | VeNCrypt (#1714), bounded cut-text (#3474), hostile-server hardening (#3473), typed error event (#3479), upstream 0.6.0 fixes ported (#3499) |
| `rdp-sidecar/vendor/ironrdp-rdpsnd` | [Devolutions/IronRDP](https://github.com/Devolutions/IronRDP) `crates/ironrdp-rdpsnd` | 0.9.0 (`ironrdp-rdpsnd-v0.9.0`) | `160752f` (#3499)        | Concrete negotiated audio format (#1773), `accepts_format` (#1812), post-0.9.0 upstream fixes ported (#3499)                                 |

The machine-readable register is [`vendor/vendored-forks.json`](../vendor/vendored-forks.json):
per fork the upstream repository and crate name, the fork base (version **and** commit), how far
upstream has been reviewed (`reviewed_version` / `reviewed_commit`), the local deltas with links,
and advisories checked and found not to apply (`acknowledged_advisories`, each with a reason).
Each fork's `README.md` also records its base version, commit and upstream URL.

**Upstream drift job (weekly).** The **Vendored Forks** workflow
([`.github/workflows/vendored-forks.yml`](../.github/workflows/vendored-forks.yml)) runs
[`scripts/internal/vendored-fork-drift.mjs`](../scripts/internal/vendored-fork-drift.mjs) every
Monday and on demand (`workflow_dispatch`). For every fork it asks:

1. **crates.io** — is there a stable upstream release newer than `reviewed_version`?
2. **GitHub** — which upstream commits touching the forked crate landed after
   `reviewed_commit`? This catches fixes before upstream releases them.
3. **OSV** — which advisories affect the upstream crate at `base_version`? OSV ingests the RustSec
   advisory database and GitHub advisories, so no build or synthetic lockfile is needed.

When anything is found it opens (or updates in place) **one** tracking issue labelled
`supply-chain`, titled "Vendored forks: upstream drift or advisories need review". When a later
run finds nothing left, it closes that issue. A failed upstream query fails the run rather than
reporting "all clear". The job is scheduled, not per-PR (#3326 lane policy), and its token can
only read the repository and write issues.

**Resolving the tracking issue.** Advisories first: an advisory that reaches our fork is a
release blocker; port the fix or re-base. Then read the listed commits and releases, port every
security or robustness fix that reaches the fork, or re-base the fork on the new upstream
release (update `base_*` in the register, the fork's `Cargo.toml` version and its README). Finally
bump `reviewed_version` / `reviewed_commit` to the upstream state you reviewed, so the next run
reports only what is newer. The long-term fix is upstreaming the deltas so a fork can be retired
and the crate consumed by version range again.

**Consistency check (per change).**
[`scripts/internal/check-vendored-forks.mjs`](../scripts/internal/check-vendored-forks.mjs) runs
offline in the same workflow whenever `vendor/**`, `rdp-sidecar/vendor/**`, a lockfile or this page
changes. It fails when a vendored directory has no register entry (or an entry has no directory),
when an entry lacks its upstream, base, reviewed state or delta links, when the fork's
`Cargo.toml` name/version drifts from the register, or when a fork README does not record its base
version, base commit and upstream URL. It also validates the watchlist below.

## Untrusted-input parser watchlist

The crates below parse bytes an attacker can control — a hostile or compromised server, a remote
client of an embedded server, or a network response (SUP-012). A parsing or soundness bug in them
is directly reachable, and most are pre-1.0, so they are the dependencies that most need to be
current. Treat an advisory against any of them as higher priority than a general dependency bump.

"Line" is the semver-compatible line in use (`0.y` before 1.0, `x` from 1.0). The consistency
check fails when the named lockfile has no locked version on that line, so a manifest bump cannot
leave this table stale. `cargo update` stays on the line, so the weekly lockfile chore never trips
it. The last three columns are prose.

| Crate              | Line  | Lockfile                               | Parses (untrusted source)                                                 | 1.0? | Our hardening / caps                                                                                                      | Tests / fuzzing                                                                           |
| ------------------ | ----- | -------------------------------------- | ------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `russh`            | 0.61  | `Cargo.lock`                           | SSH transport, key exchange, auth and channel data from SSH servers       | no   | Host key verified before auth; keyboard-interactive capped at 16 rounds (`core/src/backends/ssh/keyboard_interactive.rs`) | Unit tests; Docker SSH fixtures in the nightly integration lane; no fuzzing               |
| `russh-sftp`       | 2     | `Cargo.lock`                           | SFTP replies (directory listings, attributes, file data)                  | yes  | Remote file reads capped at 256 MiB (`MAX_REMOTE_READ_BYTES`, `core/src/files/mod.rs`)                                    | SFTP Docker fixture in the nightly integration lane; no fuzzing                           |
| `vnc-rs`           | 0.5.3 | `Cargo.lock`                           | RFB server messages and framebuffer encodings from VNC servers            | no   | Vendored fork (see above): no server-reachable panics, 8192x8192 rect cap, bounded lengths, `catch_unwind` task boundary  | Hostile-server and seeded fuzz tests (`vendor/vnc-rs/src/client/hostile_server_tests.rs`) |
| `zune-jpeg`        | 0.4   | `Cargo.lock`                           | Tight-encoded JPEG rectangles from VNC servers                            | no   | Decode errors drop the rectangle; output length checked against the reported size (`core/src/backends/vnc/jpeg.rs`)       | Unit tests in `jpeg.rs`; no fuzzing                                                       |
| `ironrdp`          | 0.17  | `rdp-sidecar/Cargo.lock`               | RDP connection sequence, graphics and virtual channels from RDP servers   | no   | Runs out of process in the RDP sidecar; sidecar IPC frames capped at 128 MiB; clipboard image size caps (#3474)           | Sidecar unit tests; no fuzzing                                                            |
| `ironrdp-pdu`      | 0.9   | `rdp-sidecar/Cargo.lock`               | RDP PDU decoding (the wire parser under `ironrdp`)                        | no   | As `ironrdp`                                                                                                              | Upstream tests only                                                                       |
| `ironrdp-rdpsnd`   | 0.9.0 | `rdp-sidecar/Cargo.lock`               | RDP audio output channel PDUs                                             | no   | Vendored fork (see above)                                                                                                 | Sidecar audio unit tests; no fuzzing                                                      |
| `suppaftp`         | 11    | `Cargo.lock`                           | FTP control replies and directory listings from FTP servers               | yes  | On the line that closes RUSTSEC-2025-0052 and RUSTSEC-2026-0271 (CRLF injection); FTPS via rustls                         | FTP Docker fixture in the nightly integration lane; no fuzzing                            |
| `vte`              | 0.13  | `Cargo.lock`, `rdp-sidecar/Cargo.lock` | Terminal escape sequences in remote shell output (screen-clear detection) | no   | Used only to recognise clear sequences (`core/src/output/screen_clear.rs`)                                                | Unit tests in `screen_clear.rs`; no fuzzing                                               |
| `libunftp`         | 0.20  | `Cargo.lock`                           | FTP commands from remote clients of the embedded FTP server               | no   | Server is opt-in and bound to a configured host; optional transfer-size cap                                               | Embedded FTP server tests (`core/src/embedded_servers/ftp_server.rs`)                     |
| `unftp-sbe-fs`     | 0.2   | `Cargo.lock`                           | Client-supplied paths mapped onto the served directory                    | no   | Rooted at the configured directory                                                                                        | Embedded FTP server tests                                                                 |
| `axum`             | 0.7   | `Cargo.lock`                           | HTTP requests from remote clients of the embedded HTTP server             | no   | Server is opt-in and bound to a configured host                                                                           | Embedded HTTP server tests (`core/src/embedded_servers/http_server.rs`)                   |
| `tower-http`       | 0.5   | `Cargo.lock`                           | Request paths resolved to served files (`ServeDir`)                       | no   | Directory listing rejects traversal outside the served root                                                               | Embedded HTTP server tests                                                                |
| `hyper`            | 1     | `Cargo.lock`, `rdp-sidecar/Cargo.lock` | HTTP/1 and HTTP/2 framing (embedded HTTP server, HTTP client responses)   | yes  | Upstream limits                                                                                                           | Upstream tests only                                                                       |
| `jsonrpsee`        | 0.24  | `Cargo.lock`                           | JSON-RPC requests received by the remote agent                            | no   | NDJSON framing with a 16 MiB line cap (`core/src/ipc/ndjson.rs`)                                                          | Agent dispatch and transport tests                                                        |
| `hickory-resolver` | 0.26  | `Cargo.lock`, `rdp-sidecar/Cargo.lock` | DNS responses (DNS lookup network tool)                                   | no   | Upstream limits                                                                                                           | Unit tests in `core/src/network/dns.rs`                                                   |
| `surge-ping`       | 0.8   | `Cargo.lock`, `rdp-sidecar/Cargo.lock` | ICMP echo replies (ping network tool)                                     | no   | Upstream limits                                                                                                           | Unit tests in `core/src/network/ping.rs`                                                  |
| `pnet_packet`      | 0.35  | `Cargo.lock`                           | IP/ICMP packets (traceroute network tool)                                 | no   | Upstream limits                                                                                                           | Unit tests in `core/src/network/traceroute.rs`                                            |
| `rustls`           | 0.23  | `Cargo.lock`, `rdp-sidecar/Cargo.lock` | TLS records and handshakes (FTPS, VeNCrypt, RDP TLS, HTTPS)               | no   | Upstream limits                                                                                                           | Upstream tests and fuzzing                                                                |
| `rustls-webpki`    | 0.103 | `Cargo.lock`, `rdp-sidecar/Cargo.lock` | X.509 certificate chains presented by servers                             | no   | Upstream limits                                                                                                           | Upstream tests and fuzzing                                                                |

Keep the table current when adding a protocol, network tool or embedded server: a new crate that
decodes remote bytes gets a row. The pre-release review of this list is part of the
[release checklist](contributing.md#pre-release-checklist).
