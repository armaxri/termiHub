# Workaround hunt — Rust backend

Scope: `core/src` (126 files), `src-tauri/src` (232), `agent/src` (46),
`rdp-sidecar/src` (13), `plugin-api/src` (8), plus all `Cargo.toml`/`build.rs`.
(`graft/src` is a frontend skill mirror of `.md` files — no Rust — and vendored
crates under `rdp-sidecar/vendor` and `vendor/vnc-rs` are third-party, excluded.)
Static analysis + reading only; no builds run.

## Headline

**The Rust codebase is remarkably clean of classic workarounds.** The signals a
workaround-hunter usually finds in bulk are essentially absent:

- **TODO/FIXME/HACK/XXX markers: 4 total, all benign** — a doc comment quoting an
  upstream TODO, a test-fixture rule literally named `"TODO"`, an `xxx` inside a
  macOS path, and a "(X11 hack)" comment describing legitimate channel reuse.
- **No `if false`, no `if true {`, no commented-out code blocks.**
- **`unimplemented!()`/`todo!()`: all in test mock backends** (NullAgent, dispatcher
  test stubs) — none on production paths.
- **`sleep` in production: exactly one** (finding WA-RS-001, a poll loop).
- **Silent `let _ =`: ~389 sites, the vast majority legitimate** best-effort
  channel-send / teardown-on-drop / cleanup; only a small state-mutating subset
  is a real problem (WA-RS-008).
- **`#[ignore]`d tests: two**, both legitimately env-gated Docker/Podman
  integration tests (WA-RS-013).
- **`#[allow(...)]`: mostly `clippy::too_many_arguments` / `type_complexity`
  (refactor debt, not workarounds) and cfg-justified `dead_code`** (WA-RS-014).

The bulk of the raw "unwrap in production" count (232 sites after excluding test
modules) is two defensible patterns: **lock-poison `.expect()`** on
`std::sync` locks (WA-RS-006) and **`serde_json::to_value(...).unwrap()`** in the
agent dispatcher (WA-RS-007). Both technically violate the repo's "No `.unwrap()`
in production code" rule and are worth a single policy fix each, but neither is a
live crash today.

## Counts by severity

| Severity | Count |
|----------|-------|
| critical | 0 |
| high     | 0 |
| medium   | 3 |
| low      | 9 |
| info     | 2 |
| **total**| **14** |

All 14 are `is_workaround: true`.

## Highest-priority (release-relevant) items

1. **WA-RS-008 (medium)** — SSH env/`DISPLAY`/xauth injection and WSL stdin writes
   swallow errors with no logging: X11 forwarding or configured env vars can
   silently fail to apply with zero diagnostic.
2. **WA-RS-002 (medium)** — Agent network diagnostics use
   `Arc::try_unwrap().unwrap().into_inner().unwrap()`; a latent panic that a
   future refactor of the scan/ping internals would turn into an agent crash.
3. **WA-RS-001 (medium)** — Embedded HTTP server shutdown polls an `AtomicBool`
   every 100ms instead of awaiting an event (poll-where-event-should-exist).
4. **WA-RS-010 (low, security)** — Test bridge + CSP relaxation + runtime
   feature-flag override are compiled into the release binary, guarded only by an
   env var; should be behind a Cargo feature that is off in shipped installers.
5. **WA-RS-003 (medium)** — App startup `.expect()`s on config/data dir creation
   crash the app (relevant to portable/USB deployments) instead of showing a
   recoverable error.

## Cross-cutting patterns

- **`unwrap`/`expect` policy is not actually enforced.** The repo rule is "No
  `.unwrap()` in production code", yet ~232 production sites exist. Almost all are
  lock-poison or infallible-serde, so the honest fix is a *policy decision*
  (adopt `parking_lot`; add a `serde_json` helper) that lets the rule be enforced
  by lint, not a mass hand-edit. (WA-RS-006, WA-RS-007.)
- **Test scaffolding lives in production code, env-gated rather than
  cfg-compiled-out.** Fault-injection hooks (WA-RS-009) and the whole test bridge
  (WA-RS-010) ship in release binaries. Moving them behind Cargo features removes
  the surface entirely for the release.
- **Best-effort error discard is used both correctly and incorrectly.** The
  `let _ = ...` idiom is fine for teardown/channel-send but is misapplied to
  state-mutating session writes where a failure is invisible (WA-RS-008).
- **Cross-platform "for now" gaps** (RDP host-clipboard reading, WA-RS-012) and
  **live-host-only test coverage** (Docker runtime resolution, WA-RS-013) are the
  only feature/coverage stopgaps found.

## Method note

grep to locate candidates, then read surrounding code to judge each. Test code
was separated from production by excluding `*_test(s).rs` / `tests/` files and,
for unwrap counting, only counting sites appearing before the first
`#[cfg(test)]` marker in each file. Defensible patterns (lock-poison, infallible
serialization, platform-return-fallthrough `#[allow(unreachable_code)]`,
deprecated-but-correct macOS pasteboard APIs, atomic-write temp files) were
verified and excluded from findings.
