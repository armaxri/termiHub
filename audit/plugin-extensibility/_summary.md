# Plugin ecosystem / extensibility — audit summary

**Angle:** plugin-extensibility · **Scope:** `plugin-api/**`, `core/src/plugin/**`,
`src/plugins/**`, `examples/plugins/**`, `docs/plugin-authoring.md`,
`scripts/package-plugin.*`, connection-type/backend registry as an extension seam.

**Verdict: SHIP-EXPERIMENTAL (and gate native loading off by default).** The
plugin *plumbing* is real, wired end-to-end, and — where it exists — carefully
engineered. But the system is not yet an *ecosystem* substrate: the SDK is
unobtainable by third parties, the ABI churns and breaks all native plugins on
every host update, the extension seam caps third-party backends below the
built-ins, and the trust model is inverted for a safety-critical release. Ship it
labelled experimental, gate native-plugin loading behind an explicit opt-in like the
frontend one already is, and do not encourage external plugin development until the
SDK/ABI/trust issues below are addressed.

## What is genuinely good (build on it, don't re-litigate)

The **ABI soundness engineering is strong**: hand-rolled `#[repr(C)]` opaque-handle
ABI (no `dyn`/`String`/`Vec` crosses), destructor-carrying owned types so each side
frees its own allocations, double-boxed thin pointers, `catch_unwind` guards at every
`extern "C"` entry, `Arc<LoadedLibrary>` keep-alive so a live session can't dangle,
and a compile-time `improper_ctypes` proof of FFI-safety (`symbols.rs`). The
**management + trust layer is thorough**: signature/trust-store with trust-on-first-
use, tampered-hard-block, zip-slip + zip-bomb + verify/extract-TOCTOU guards,
permission-consistency-at-load, path-scope guard, and a bounded restart-then-disable
recovery machine. The **frontend JS path** was moved into a least-privilege Worker
sandbox on an app-controlled `plugin://` origin, default-off. The runtime **is**
wired into the app (host, loader, `plugin://` protocol, Tauri commands, a
`PluginSettingsSection` management UI) — contrary to the docs' stale "may not be
present" banner. These are not the problem; the *ecosystem viability* gaps below are.

## The strategic read

- **ABI/API design & stability:** The ABI is well-*implemented* but not yet
  *stable*: a single monotonic `u32` (now **4**), churned through four breaking bumps
  pre-release, gated by **exact** equality. Against an auto-updating app this means
  every ABI-touching update silently orphans all installed native plugins, and the
  native skew doesn't even route through the graceful auto-disable path (that keys on
  a *separate* manifest version string frozen at `"1.0"`). Two decoupled version
  schemes share one name and disagree. (PLG-002, PLG-003)
- **Extension-seam completeness:** Not to parity. Plugin backends hardcode
  `monitoring/file_browser/graphical/persistent = false`; the ABI vtable is four
  methods (write/resize/close/is_alive). A third-party backend can never offer SFTP,
  monitoring, a graphical surface, or reconnect — all of which built-ins have. And the
  seam is **not dogfooded**: no built-in ships through the ABI; only the echo example
  exercises it. (PLG-004, PLG-005)
- **Trust & distribution:** Inverted. The *most* privileged plugin type (native,
  in-process, full app authority, cooperative-only bridge) is gated by a one-time
  install acknowledgement; the *least* privileged (sandboxed JS, no IPC) is the one
  hidden behind a default-off experimental switch. Signing proves provenance, not
  containment. For an ecosystem the native path needs out-of-process (the app already
  has an agent/JSON-RPC transport to reuse) or WASM isolation. (PLG-006)
- **Developer experience:** The SDK crate is `publish = false` and consumable only by
  relative path inside the monorepo — a third party literally cannot depend on it. The
  example builds and is well-tested, but only single-OS packaging exists (no fat/cross
  package the loader nonetheless supports), packaging isn't exercised in CI, manifest
  `settings` never reach the backend, and the backend gets no host context/logger. The
  authoring doc is stale on status and self-contradictory on versioning.
  (PLG-001, PLG-008, PLG-010, PLG-011, PLG-014)

## Findings index

| ID | Sev | Cat | Title |
|----|-----|-----|-------|
| [PLG-001](0001-no-published-sdk-crate.md) | high | arch | No published/versioned SDK crate — third parties can't depend on the ABI |
| [PLG-002](0002-dual-decoupled-version-schemes.md) | high | arch | Two decoupled version schemes — manifest `"1.0"` vs native ABI `u32=4` |
| [PLG-003](0003-abi-exact-match-churn-orphans-plugins.md) | high | arch | Exact-match ABI gate + churn → every auto-update orphans all native plugins |
| [PLG-004](0004-capability-ceiling-plugin-backends-second-class.md) | high | arch | Capability ceiling — plugin backends can't reach built-in parity |
| [PLG-005](0005-seam-not-dogfooded.md) | medium | arch | Native-plugin seam not dogfooded — no built-in uses the ABI |
| [PLG-006](0006-inverted-trust-models.md) | high | security | Inverted trust models — privileged native gated by an ack; sandboxed JS default-off |
| [PLG-007](0007-connectiontype-id-load-order-dependent.md) | medium | reliability | Plugin connectionType id is load-order-dependent → breaks saved connections *(workaround)* |
| [PLG-008](0008-manifest-settings-not-delivered-to-backend.md) | medium | missing-feature | Manifest `settings` persisted but never delivered to the native backend |
| [PLG-009](0009-frontend-extension-points-behind-default-off-gate.md) | medium | missing-feature | protocolParser/statusBarWidget only work behind a default-off, no-enforcement gate *(workaround)* |
| [PLG-010](0010-docs-stale-and-incomplete.md) | medium | docs | plugin-authoring.md status banner & version guidance stale/incomplete |
| [PLG-011](0011-no-cross-platform-packaging-or-ci.md) | medium | tooling | No cross-platform/fat packaging; packer single-OS; packaging not in CI |
| [PLG-012](0012-no-update-versioning-or-discovery.md) | medium | missing-feature | No plugin update/version semantics or discovery/registry |
| [PLG-013](0013-no-rust-toolchain-compat-record.md) | medium | arch | No Rust-toolchain compat record/enforcement — u32 gate insufficient for soundness |
| [PLG-014](0014-backend-gets-no-host-context.md) | low | missing-feature | Backend gets no host context (data dir, logger, own settings, version) |

**Totals:** 14 findings — 0 critical, 5 high, 8 medium, 1 low. 2 marked
`is_workaround: true` (PLG-007, PLG-009).

## Top 5, ranked

1. **PLG-006 — inverted trust model.** For a safety-critical release, arbitrary
   in-process native code running on a one-time install checkbox is the headline risk.
   Gate native loading off by default now; plan out-of-process/WASM for the ecosystem.
2. **PLG-003 — ABI churn orphans all native plugins on auto-update.** Exact-match +
   four pre-release breaking bumps + background updater = plugins that die on routine
   updates. Freeze the ABI and make the gate additive before promising a contract.
3. **PLG-001 — no obtainable SDK.** `publish = false`, path-only deps: the "third
   party" of a third-party plugin ABI cannot exist. Publish the crate or document a
   supported git/tag dep.
4. **PLG-004 — capped extension seam.** Plugin backends can't offer file browsing,
   monitoring, graphical, or reconnect — permanently second-class vs built-ins. Decide
   and document the ceiling, or grow the ABI to parity.
5. **PLG-002 — two decoupled version schemes.** The manifest gate is meaningless for
   native plugins and the friendly auto-disable never fires on real (ABI) skew. Unify
   to one number the packer sets.

## Release recommendation

**Ship-experimental with native loading gated off by default.** Concretely, before
v0.1.0: (a) put native-plugin *loading* behind an explicit default-off opt-in
mirroring `frontendPluginsEnabled` (PLG-006); (b) freeze the ABI and switch the gate
to additive major/minor, routing skew through graceful auto-disable (PLG-002/003);
(c) label the whole plugin system experimental in-app and in docs. The `theme`
extension point is genuinely low-risk and could ship un-gated. Everything else should
carry an experimental label until the SDK is obtainable (PLG-001), the seam's ceiling
is decided (PLG-004), and the trust model is resolved (PLG-006). The engineering
quality is high enough that these are *strategy and completeness* fixes, not rewrites.
