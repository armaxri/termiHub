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

| Override                         | Pin              | Parent (declared range)                                                                             | Advisory                                                                                                            | Removal condition                                                |
| -------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `markdown-it`                    | `>=14.3.1 <15`   | markdownlint-cli2 0.22.1 (`14.1.1`, exact)                                                          | GHSA-6v5v-wf23-fmfq (smartquotes DoS), GHSA-253c-mchw-3w2r (linkify DoS)                                            | markdownlint-cli2 depends on markdown-it >=14.3.1                |
| `js-yaml`                        | `>=4.3.2 <5`     | @eslint/eslintrc 3.3.7 (`^4.3.2`), cosmiconfig 9.0.1 (`^4.1.0`), markdownlint-cli2 0.22.1 (`4.1.1`) | GHSA-h67p-54hq-rp68, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh                                                       | every parent's range starts at or above the floor                |
| `flatted`                        | `>=3.4.2`        | flat-cache 4.0.1 (`^3.2.9`), via eslint                                                             | GHSA-rf6f-7fwh-wjgh, GHSA-25h7-pfq9-p65f                                                                            | flat-cache requires flatted >=3.4.2                              |
| `fast-uri`                       | `>=3.1.6 <4`     | ajv 8.18.0 (`^3.0.1`), via commitlint                                                               | GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp and earlier                                           | ajv requires fast-uri >=3.1.6                                    |
| `rollup`                         | `>=4.59.0`       | vite 6.4.3 (`^4.34.9`)                                                                              | GHSA-mw96-cpmx-2vgc (path-traversal file write)                                                                     | vite requires rollup >=4.59.0                                    |
| `postcss`                        | `>=8.5.23`       | vite 6.4.3 (`^8.5.3`)                                                                               | GHSA-qx2v-qp2m-jg93, GHSA-r28c-9q8g-f849, GHSA-fxqj-rqcc-2cmp                                                       | vite requires postcss >=8.5.23                                   |
| `undici`                         | `>=7.29.0 <8`    | jsdom 28.1.0 (`^7.21.0`)                                                                            | GHSA-4cwx-7wf7-3272, GHSA-8xcm-r25x-g524, GHSA-m8rv-5g2x-5cg5, GHSA-jr45-8vmc-qm54, GHSA-v3r7-h72x-cjcm and earlier | jsdom requires undici >=7.29.0                                   |
| `vite>picomatch`                 | `>=4.0.4`        | vite 6.4.3 (`^4.0.2`)                                                                               | GHSA-c2c7-rcm5-vvqj (ReDoS), GHSA-3v7f-55p6-f55p                                                                    | vite requires picomatch >=4.0.4                                  |
| `vitest>picomatch`               | `>=4.0.4`        | vitest 4.1.11 (`^4.0.3`)                                                                            | GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p                                                                            | vitest requires picomatch >=4.0.4                                |
| `micromatch>picomatch`           | `2.3.2`          | micromatch 4.0.8 (`^2.3.1`)                                                                         | GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p                                                                            | micromatch requires picomatch >=2.3.2                            |
| `minimatch@3>brace-expansion`    | `>=1.1.18 <2`    | minimatch 3.1.5 (`^1.1.7`), via eslint                                                              | GHSA-f886-m6hf-6m8v, GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895                                  | minimatch 3 requires brace-expansion >=1.1.18, or leaves tree    |
| `smol-toml`                      | `>=1.7.1 <2`     | markdownlint-cli2 0.22.1 (`1.6.1`, exact)                                                           | GHSA-7w5x-hrqm-74c2 (malformed-TOML DoS)                                                                            | markdownlint-cli2 depends on smol-toml >=1.7.1                   |
| `micromark-extension-math>katex` | `>=0.18.2 <0.19` | micromark-extension-math 3.1.0 (`^0.16.0`), via markdownlint 0.40.0                                 | GHSA-238p-pmpm-9mq7 (prototype pollution bypasses trust)                                                            | micromark-extension-math requires katex >=0.18.2, or leaves tree |

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
  advisory, and every soft-pass writes an **AUDIT SKIPPED — registry unreachable** marker to
  the job summary. On `main`, `release/*` branches and tags — and in the Release workflow,
  which sets `AUDIT_STRICT=1` — it runs in **strict mode**: an unreachable registry fails the
  job instead, so an unaudited tree never ships (WA-CI-008). Re-run the job once the registry
  is reachable.
- **Full tree (incl. devDependencies) — advisory, except when a fix exists.** Dev/build
  tooling does not ship, so a dev-only advisory with no patched version does not block
  unrelated PRs. The step still writes a per-severity count to the job summary and raises a
  warning annotation when any high or critical advisory is present, so it is visible without
  reading the log. A high or critical advisory that **already has a patched version** fails the
  step ([`scripts/internal/pnpm-audit-summary.mjs`](../scripts/internal/pnpm-audit-summary.mjs),
  #3755): take the fix by bumping the tool, running `pnpm update <pkg>`, or adding/raising an
  override (with a row above). If the fix truly cannot be taken yet, add the advisory's GHSA id
  to `pnpm.auditConfig.ignoreGhsas` in `package.json` and list it here with the reason and
  what unblocks it.
- **Rust tree at release time — blocking (#4282).** The Release workflow's **Verify Rust
  Supply Chain** job runs `cargo audit` and `cargo deny check advisories bans licenses sources`
  on the tagged commit for the workspace, and `cargo deny` for the RDP sidecar's own lockfile,
  with pinned tool versions. RUSTSEC advisories and yanks are time-based, so this grades the
  advisory database as of the tag, not as of the merge: an advisory published after the merge
  blocks the release too. It also checks both lockfiles are fresh, and every release cargo
  build passes `--locked`. Every build job needs this job, so nothing is built or published
  until it passes. Accept an advisory the usual way (`deny.toml` / `.cargo/audit.toml` with a
  row under _Accepted risks_ below), never by skipping the gate.

### Accepted advisories (`pnpm.auditConfig.ignoreGhsas`)

| GHSA                  | Package (path)                               | Severity | Why accepted                                                                              | Unblocked by                                         |
| --------------------- | -------------------------------------------- | -------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `GHSA-p98j-92pf-mc4p` | dompurify 3.4.15 (`monaco-editor>dompurify`) | low      | IN_PLACE-only; Monaco never sets `IN_PLACE`, and the shipped copy is vendored (see below) | a monaco-editor release vendoring DOMPurify >=3.4.16 |
| `GHSA-6688-9rhm-gjv2` | dompurify 3.4.15 (`monaco-editor>dompurify`) | low      | same as above                                                                             | a monaco-editor release vendoring DOMPurify >=3.4.16 |

Why these are accepted rather than overridden (#4156): monaco-editor 0.57.0 declares
`dompurify: 3.4.15` but never imports the npm package. It ships a **vendored, pre-bundled copy**
at `monaco-editor/esm/vs/base/browser/dompurify/dompurify.js`, imported by `domSanitize.js`.
A `monaco-editor>dompurify` override only swaps the unused `node_modules` copy: with
`>=3.4.16 <4` the lockfile resolved 3.4.16, yet `pnpm build` still emitted
`@license DOMPurify 3.4.15` in the Monaco chunk. It would silence the audit without changing a
shipped byte. Both advisories need DOMPurify's `IN_PLACE` mode, and Monaco's `domSanitize.js`
calls `sanitize` only with `RETURN_DOM_FRAGMENT` / `RETURN_TRUSTED_TYPE`, so the vendored copy
is not reachable through them. Remove both ids when Monaco ships a release pinning
DOMPurify >=3.4.16 (0.57.0 is the latest stable as of 2026-10-06), then bump monaco-editor.
Earlier `dompurify` overrides (removed in #3482) had the same blind spot.

### Accepted risks (Rust advisories and pre-release crates)

The Rust side of the Security Audit workflow
([`security-audit.yml`](../.github/workflows/security-audit.yml)) runs `cargo audit` (config:
[`.cargo/audit.toml`](../.cargo/audit.toml)) and `cargo deny check` (config:
[`deny.toml`](../deny.toml)) on the root workspace. Its **Security Audit (RDP sidecar)** job
runs the same two tools from `rdp-sidecar/` against the sidecar's own `Cargo.lock` (config:
[`rdp-sidecar/.cargo/audit.toml`](../rdp-sidecar/.cargo/audit.toml) and
[`rdp-sidecar/deny.toml`](../rdp-sidecar/deny.toml)), #4357. Both run on every push to
`develop`/`main`, daily over both branches, and on PRs that change a dependency manifest or
lockfile. A real vulnerability or a yanked crate fails the job. The entries below are the only exceptions. Each is a transitive
crate pinned by an upstream dependency, with no fix we can take today, and the maintainer
accepted each as a documented risk on 2026-10-06 (#3054, #3734) instead of waiting on upstream.
The ignore lists carry the same rationale next to each ID.

#### Advisories ignored in the root workspace

| Advisory            | Crate (path)                                          | Kind          | Why it is not exploitable in termiHub                                                                                                                                                                                                                                                     | Leaves the tree when                    |
| ------------------- | ----------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `RUSTSEC-2023-0071` | rsa 0.10.0-rc (`russh`, `ssh-key`)                    | vulnerability | termiHub is an SSH client only. RSA client keys sign the server-chosen session hash once per login, and host-key checks are public-key verifications. There is no RSA decryption path, and a server sees one signature per connection, far from the timed sample the Marvin attack needs. | an rsa release with a constant-time fix |
| `RUSTSEC-2024-0370` | proc-macro-error 1.0 (`glib-macros` 0.18, Linux GTK3) | unmaintained  | Build-time proc-macro helper. It runs only at compile time on our own sources and ships no runtime code.                                                                                                                                                                                  | Tauri/wry move off gtk-rs 0.18          |
| `RUSTSEC-2024-0429` | glib 0.18 (Tauri/wry Linux GTK3 stack)                | unsound       | The unsoundness is in `glib::VariantStrIter`'s iterator impls over GVariant string arrays, which termiHub code never calls. Our only direct glib use is GTK signal handlers in the Linux drag-out path (`src-tauri/src/files/drag_out.rs`).                                               | Tauri/wry move to glib 0.20+            |

cargo-deny lists only `RUSTSEC-2023-0071`. It never reports the transitive glib notice
(`unsound = "workspace"`) and does not gate unmaintained crates (`unmaintained = "none"`), so an
ignore entry for those would be stale. The rdp-sidecar keeps its own lists in
`rdp-sidecar/.cargo/audit.toml` and `rdp-sidecar/deny.toml`.

Cleared on 2026-10-06: the five `unic-*` advisories (RUSTSEC-2025-0075, -0080, -0081, -0098,
-0100) left the tree with the Tauri 2.12 bump, because tauri-utils 2.10 moved from urlpattern 0.3
to 0.6, which uses `icu_properties`. The `serial`, `rustls-pemfile` and `git2` ignores went
earlier, with #3974, #3975 and #3973.

#### Pre-release crates (#3734)

russh 0.61 (SSH) and the rdp-sidecar IronRDP/picky stack are built on the RustCrypto 0.7/0.10
line and the Dalek 3/5 line, which upstream has only published as release candidates (`-rc.N`,
`-pre.N`). The full set is in
[`.github/prerelease-allowlist.json`](../.github/prerelease-allowlist.json). It is accepted
because:

- `Cargo.lock` pins every exact version, so nothing moves without a reviewed lockfile change.
- cargo-audit and cargo-deny cover these crates like any other crate. An advisory or a yank
  against one of them fails CI. The yanked gate is what caught the crypto-bigint 0.7.0-0.7.4
  yank.
- We move to the stable releases when upstream publishes them, by bumping russh and IronRDP.

`bollard-stubs` is also on the allowlist, but it is not a risk: it uses the Docker Engine API
version as a permanent pre-release tag (#3735).

#### How entries leave

Removal is enforced, so this list cannot outlive the risk it describes:

- [`scripts/internal/check-prerelease-crates.mjs`](../scripts/internal/check-prerelease-crates.mjs)
  runs on every PR. It fails when a pre-release is locked without an allowlist entry, and when an
  entry no longer matches any locked crate.
- `cargo deny check` reports an `ignore` entry whose advisory no longer matches as
  `advisory-not-detected`.
- cargo-audit does not flag a stale ignore. When a crate leaves `Cargo.lock`, remove its ID from
  `.cargo/audit.toml` and its row above in the same PR. To check by hand whether an ID still
  fires, run cargo-audit outside the repo so the config is not picked up:
  `cd /tmp && cargo audit -f <repo>/Cargo.lock`.

## Vendored forks

Six third-party crates are carried as in-tree forks (SUP-005). A fork is consumed by **path** or
by **`[patch.crates-io]`**, so `cargo update`, Dependabot, `cargo audit` and `cargo deny` never
see the upstream crate again: an upstream security fix is not pulled in and a RustSec advisory
against the upstream crate is not reported. All forks sit on paths that handle bytes from outside
the app (remote servers, clients of the embedded servers, or attached devices), so the upstream crate is watched explicitly instead.

| Fork                                | Upstream                                                                              | Base                                  | Reviewed up to           | Why it is forked                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vendor/vnc-rs`                     | [HsuJv/vnc-rs](https://github.com/HsuJv/vnc-rs)                                       | 0.5.3 (`f8ac0ee`)                     | 0.6.0 (`99ed1a2`, #3499) | VeNCrypt (#1714), bounded cut-text (#3474), hostile-server hardening (#3473), typed error event (#3479), upstream 0.6.0 fixes ported (#3499)                                     |
| `rdp-sidecar/vendor/ironrdp-rdpsnd` | [Devolutions/IronRDP](https://github.com/Devolutions/IronRDP) `crates/ironrdp-rdpsnd` | 0.9.0 (`ironrdp-rdpsnd-v0.9.0`)       | `160752f` (#3499)        | Concrete negotiated audio format (#1773), `accepts_format` (#1812), post-0.9.0 upstream fixes ported (#3499), pre-v8 WaveInfo + Wave playback (#3510)                            |
| `rdp-sidecar/vendor/ironrdp-pdu`    | [Devolutions/IronRDP](https://github.com/Devolutions/IronRDP) `crates/ironrdp-pdu`    | 0.9.0 (`ironrdp-pdu-v0.9.0`)          | 0.9.0 (`11a0810`)        | 6-byte Share Control Header for xrdp's short Deactivate All PDU (#3611), port of unreleased upstream `d4b728a`                                                                   |
| `rdp-sidecar/vendor/ironrdp-rdpdr`  | [Devolutions/IronRDP](https://github.com/Devolutions/IronRDP) `crates/ironrdp-rdpdr`  | 0.7.0 (`ironrdp-rdpdr-v0.7.0`)        | 0.7.0 (`11a0810`)        | Drive name in the announce's PreferredDosName instead of `ignored`, so xrdp mounts drives under their names (#4125), port of unreleased upstream `161409e`                       |
| `vendor/serial2`                    | [de-vri-es/serial2-rs](https://github.com/de-vri-es/serial2-rs)                       | 0.2.38 (`v0.2.38`, `448a20e`)         | 0.2.38 (`448a20e`)       | macOS termios-speed fallback when `IOSSIOSPEED` is rejected, so pseudo-terminal serial ports open (#3701)                                                                        |
| `vendor/libunftp`                   | [bolcom/libunftp](https://github.com/bolcom/libunftp)                                 | 0.23.1 (`libunftp-0.23.1`, `8d3f28c`) | 0.23.1 (`8d3f28c`)       | PROXY header reader ends at EOF instead of spinning on a connection closed before its header (#4099); prebound listener + PROXY peer filter, so only the relay is served (#4100) |

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

### Upstreaming status

Each fork is watched until its deltas are accepted upstream and it can be retired. A delta that is
ready to submit carries a prepared patch and pull-request description next to the fork; opening it
upstream is a maintainer action.

| Fork                               | Upstream delta                                                                       | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Retire when                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `vendor/serial2`                   | macOS `IOSSIOSPEED` → termios fallback (#3701)                                       | Prepared, not yet submitted: patch against `v0.2.38` and PR text in [`vendor/serial2/UPSTREAM.md`](../vendor/serial2/UPSTREAM.md) (#3704)                                                                                                                                                                                                                                                                                                                                  | A `serial2` release contains the fallback; retirement steps are in `UPSTREAM.md`                             |
| `rdp-sidecar/vendor/ironrdp-rdpdr` | Drive name in PreferredDosName instead of `ignored` (#4125)                          | Fixed on upstream master (`161409e`, IronRDP#1566), unreleased; that commit also switched DeviceData to UTF-16LE, which breaks Windows drive names (IronRDP#2075). Posted 2026-10-06: [xrdp data point and release request on IronRDP#2075](https://github.com/Devolutions/IronRDP/issues/2075#issuecomment-6011424177); fallback issue and 0.7.0 backport patch stay in [`rdp-sidecar/vendor/ironrdp-rdpdr/UPSTREAM.md`](../rdp-sidecar/vendor/ironrdp-rdpdr/UPSTREAM.md) | An `ironrdp-rdpdr` release has `for_drive` and a DeviceData encoding Windows accepts; steps in `UPSTREAM.md` |
| `vendor/libunftp`                  | PROXY header reader EOF → error instead of a spin (#4099)                            | Submitted 2026-10-06: issue [libunftp#580](https://github.com/bolcom/libunftp/issues/580), pull request [libunftp#582](https://github.com/bolcom/libunftp/pull/582) (open); text in [`vendor/libunftp/UPSTREAM.md`](../vendor/libunftp/UPSTREAM.md)                                                                                                                                                                                                                        | A `libunftp` release contains the fix; retirement steps are in `UPSTREAM.md`                                 |
| `vendor/libunftp`                  | `Server::listen_with_listener` + `ServerBuilder::proxy_protocol_peer_filter` (#4100) | Proposed 2026-10-06: issue [libunftp#581](https://github.com/bolcom/libunftp/issues/581); the pull request waits for maintainer feedback. Patch and PR text in [`vendor/libunftp/UPSTREAM.md`](../vendor/libunftp/UPSTREAM.md)                                                                                                                                                                                                                                             | A `libunftp` release has both APIs (or equivalents); steps are in `UPSTREAM.md`                              |

When the Vendored Forks drift job reports new `serial2`, `libunftp` or `ironrdp-rdpdr` commits or a release, check
whether the delta landed before porting anything else: if it did, retire the fork instead of re-basing it.
Once the pull request is open, add its link to the delta's `refs` in
[`vendor/vendored-forks.json`](../vendor/vendored-forks.json) and to the table above.

## Untrusted-input parser watchlist

The crates below parse bytes an attacker can control — a hostile or compromised server, a remote
client of an embedded server, or a network response (SUP-012). A parsing or soundness bug in them
is directly reachable, and most are pre-1.0, so they are the dependencies that most need to be
current. Treat an advisory against any of them as higher priority than a general dependency bump.

"Line" is the semver-compatible line in use (`0.y` before 1.0, `x` from 1.0). The consistency
check fails when the named lockfile has no locked version on that line, so a manifest bump cannot
leave this table stale. `cargo update` stays on the line, so the weekly lockfile chore never trips
it. The last three columns are prose.

| Crate              | Line  | Lockfile                               | Parses (untrusted source)                                                                     | 1.0? | Our hardening / caps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Tests / fuzzing                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ----- | -------------------------------------- | --------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `russh`            | 0.61  | `Cargo.lock`                           | SSH transport, key exchange, auth and channel data from SSH servers                           | no   | Host key verified before auth; keyboard-interactive capped at 16 rounds (`core/src/backends/ssh/keyboard_interactive.rs`)                                                                                                                                                                                                                                                                                                                                                                                                   | Unit tests; Docker SSH fixtures in the nightly integration lane; no fuzzing                                                                                                                                                                                                                                                                                                      |
| `russh-sftp`       | 2     | `Cargo.lock`                           | SFTP replies (directory listings, attributes, file data)                                      | yes  | Remote file reads capped at 256 MiB (`MAX_REMOTE_READ_BYTES`, `core/src/files/mod.rs`)                                                                                                                                                                                                                                                                                                                                                                                                                                      | SFTP Docker fixture in the nightly integration lane; no fuzzing                                                                                                                                                                                                                                                                                                                  |
| `vnc-rs`           | 0.5.3 | `Cargo.lock`                           | RFB server messages and framebuffer encodings from VNC servers                                | no   | Vendored fork (see above): no server-reachable panics, 8192x8192 rect cap, bounded lengths, `catch_unwind` task boundary                                                                                                                                                                                                                                                                                                                                                                                                    | Hostile-server and seeded fuzz tests (`vendor/vnc-rs/src/client/hostile_server_tests.rs`)                                                                                                                                                                                                                                                                                        |
| `zune-jpeg`        | 0.4   | `Cargo.lock`                           | Tight-encoded JPEG rectangles from VNC servers                                                | no   | Decode errors drop the rectangle; output length checked against the reported size (`core/src/backends/vnc/jpeg.rs`)                                                                                                                                                                                                                                                                                                                                                                                                         | Unit tests in `jpeg.rs`; no fuzzing                                                                                                                                                                                                                                                                                                                                              |
| `ironrdp`          | 0.17  | `rdp-sidecar/Cargo.lock`               | RDP connection sequence, graphics and virtual channels from RDP servers                       | no   | Runs out of process in the RDP sidecar; sidecar IPC frames capped at 128 MiB; clipboard image size caps (#3474)                                                                                                                                                                                                                                                                                                                                                                                                             | Sidecar unit tests; no fuzzing                                                                                                                                                                                                                                                                                                                                                   |
| `ironrdp-pdu`      | 0.9   | `rdp-sidecar/Cargo.lock`               | RDP PDU decoding (the wire parser under `ironrdp`)                                            | no   | Vendored fork (see above); as `ironrdp`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Sidecar Share Control Header unit tests (#3611); upstream tests                                                                                                                                                                                                                                                                                                                  |
| `ironrdp-rdpdr`    | 0.7   | `rdp-sidecar/Cargo.lock`               | RDP device-redirection (drive I/O request) PDUs                                               | no   | Vendored fork (see above); opt-in per connection, serves only the one selected folder with symlink escapes refused (#1757)                                                                                                                                                                                                                                                                                                                                                                                                  | Fork unit tests for the drive announce (#4125); sidecar drive-backend unit tests; live xrdp RDP-15; no fuzzing                                                                                                                                                                                                                                                                   |
| `ironrdp-rdpsnd`   | 0.9.0 | `rdp-sidecar/Cargo.lock`               | RDP audio output channel PDUs                                                                 | no   | Vendored fork (see above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Sidecar audio unit tests; no fuzzing                                                                                                                                                                                                                                                                                                                                             |
| `suppaftp`         | 11    | `Cargo.lock`                           | FTP control replies and directory listings from FTP servers                                   | yes  | On the line that closes RUSTSEC-2025-0052 and RUSTSEC-2026-0271 (CRLF injection); FTPS via rustls                                                                                                                                                                                                                                                                                                                                                                                                                           | FTP Docker fixture in the nightly integration lane; no fuzzing                                                                                                                                                                                                                                                                                                                   |
| `serial2`          | 0.2   | `Cargo.lock`                           | Serial-port bytes and termios state from attached serial devices                              | no   | Vendored fork (see above); the serial backend does no protocol parsing, it forwards bytes to the terminal                                                                                                                                                                                                                                                                                                                                                                                                                   | `core/src/backends/serial.rs` unit + macOS pty tests; upstream tests                                                                                                                                                                                                                                                                                                             |
| `libunftp`         | 0.23  | `Cargo.lock`                           | FTP commands from remote clients of the embedded FTP server (incl. MLSD/MLST/EPSV since 0.21) | no   | Vendored fork (see above): the PROXY header reader ends at EOF (#4099), and the loopback listener serves only relay-opened connections (#4100). Server is opt-in and bound to a configured host; reachable only through termiHub's front relay, which caps control lines at 8 KiB and fronts the passive ports (libunftp runs on loopback in PROXY mode, #3996); optional transfer-size cap; passive-only, plain FTP (no FTPS, so the X.509 client-cert parsing in `unftp-core` is unreachable); reviewed at 0.23.1 (#3975) | Embedded FTP server tests incl. real socket sessions through the relay: overlong-line rejection, PASV/EPSV STOR/LIST/RETR, client-IP attribution, data-source rejection, a header-less backend connection leaves no task, a direct loopback connection with a forged PROXY header is refused and logged (`core/src/embedded_servers/ftp_server/relay_tests.rs`); fork unit tests |
| `unftp-sbe-fs`     | 0.4   | `Cargo.lock`                           | Client-supplied paths mapped onto the served directory                                        | no   | Rooted at the configured directory through a `cap-std` directory handle; an unopenable root fails the session instead of panicking (#3975)                                                                                                                                                                                                                                                                                                                                                                                  | Embedded FTP server tests                                                                                                                                                                                                                                                                                                                                                        |
| `axum`             | 0.7   | `Cargo.lock`                           | HTTP requests from remote clients of the embedded HTTP server                                 | no   | Server is opt-in and bound to a configured host                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Embedded HTTP server tests (`core/src/embedded_servers/http_server.rs`)                                                                                                                                                                                                                                                                                                          |
| `tower-http`       | 0.5   | `Cargo.lock`                           | Request paths resolved to served files (`ServeDir`)                                           | no   | Directory listing rejects traversal outside the served root                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Embedded HTTP server tests                                                                                                                                                                                                                                                                                                                                                       |
| `hyper`            | 1     | `Cargo.lock`, `rdp-sidecar/Cargo.lock` | HTTP/1 and HTTP/2 framing (embedded HTTP server, HTTP client responses)                       | yes  | Upstream limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Upstream tests only                                                                                                                                                                                                                                                                                                                                                              |
| `jsonrpsee`        | 0.24  | `Cargo.lock`                           | JSON-RPC requests received by the remote agent                                                | no   | NDJSON framing with a 16 MiB line cap (`core/src/ipc/ndjson.rs`)                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Agent dispatch and transport tests                                                                                                                                                                                                                                                                                                                                               |
| `hickory-resolver` | 0.26  | `Cargo.lock`, `rdp-sidecar/Cargo.lock` | DNS responses (DNS lookup network tool)                                                       | no   | Upstream limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Unit tests in `core/src/network/dns.rs`                                                                                                                                                                                                                                                                                                                                          |
| `surge-ping`       | 0.8   | `Cargo.lock`, `rdp-sidecar/Cargo.lock` | ICMP echo replies (ping network tool)                                                         | no   | Upstream limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Unit tests in `core/src/network/ping.rs`                                                                                                                                                                                                                                                                                                                                         |
| `pnet_packet`      | 0.35  | `Cargo.lock`                           | IP/ICMP packets (traceroute network tool)                                                     | no   | Upstream limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Unit tests in `core/src/network/traceroute.rs`                                                                                                                                                                                                                                                                                                                                   |
| `rustls`           | 0.23  | `Cargo.lock`, `rdp-sidecar/Cargo.lock` | TLS records and handshakes (FTPS, VeNCrypt, RDP TLS, HTTPS)                                   | no   | Upstream limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Upstream tests and fuzzing                                                                                                                                                                                                                                                                                                                                                       |
| `rustls-webpki`    | 0.103 | `Cargo.lock`, `rdp-sidecar/Cargo.lock` | X.509 certificate chains presented by servers                                                 | no   | Upstream limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Upstream tests and fuzzing                                                                                                                                                                                                                                                                                                                                                       |

Keep the table current when adding a protocol, network tool or embedded server: a new crate that
decodes remote bytes gets a row. The pre-release review of this list is part of the
[release checklist](contributing.md#pre-release-checklist).
