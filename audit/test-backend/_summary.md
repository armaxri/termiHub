# Test coverage & testability — Rust backend (test-backend)

Audit of how well the Rust side (core + src-tauri + agent + plugin-api + rdp-sidecar) is tested —
breadth **and** quality — for the pre-release audit. Read-only; no builds/coverage run.

## Headline

Backend test coverage is **broad in count but not release-adequate in quality**. There are ~3,800
`#[test]`/`#[tokio::test]` unit-test attributes in `src/**` and ~176 integration-test functions —
a large, healthy-looking number. But the *shape* of that coverage lets exactly the class of defect
other experts found ship uncaught:

- The **highest-value behavioral tests run on a dark lane** (per-PR CI compiles core integration
  tests `--no-run` and the agent live-TCP set is Windows-quarantined). The bulk of real backend
  behavior is verified at release cadence, not on the PR that changes it (TBE-006, TBE-009).
- **Mocks diverge from real backends** in the safety-relevant direction (mock clamps VNC size, real
  does not) — so tests are green while the real path is exposed (TBE-003).
- **Hostile/malformed input is barely tested** on parsing/framing paths (NDJSON unbounded line,
  VNC oversize resize) (TBE-002, TBE-003).
- A unit test **entrenches a bug** (SSH exec signal-death → exit 0) rather than catching it (TBE-001).
- **Concurrency has no adversarial coverage** — no two-client-on-one-session test, so the reported
  agent AB-BA deadlock is structurally invisible (TBE-008); reconnect races have no fast unit test
  (TBE-011).
- **Unsafe plugin FFI teardown** (the reported use-after-free) has no lifecycle/Miri test (TBE-010).
- **No Rust coverage gate at all**, while the frontend has one (TBE-007).

Every un-caught defect the brief lists maps to one of these systemic gaps. Coverage is **not
release-adequate** as-is; the fixes are mostly structural (move contract/limit checks into per-PR
unit tests, add memory-safety + concurrency lanes, add a Rust coverage floor) rather than dozens of
one-off tests.

## Coverage-by-risk map (critical Rust area × test state)

| Area | Unit (per-PR) | Integration (dark lane) | Adversarial / hostile-input | Verdict |
|---|---|---|---|---|
| SSH exec exit handling | present but **entrenches bug** | live only | none (ExitSignal path) | **critical gap** (TBE-001) |
| NDJSON / spawn+agent framing | happy-path only | — | **none** (unbounded line) | **high gap** (TBE-002) |
| VNC decode/resize | frame blit/copy well-tested | live, normal-size only | **none** (mock clamps) | **high gap** (TBE-003) |
| Wire contract (rename/delete DTOs) | — | live only | — | **high gap** (TBE-009) |
| Agent session — concurrency | single-client only | per-agent parallel, not per-session | **none** (2-client) | **high gap** (TBE-008) |
| Plugin FFI teardown/soundness | load-time only | happy-path roundtrip | **none** (no Miri/UAF) | **high gap** (TBE-010) |
| Reconnect state machine | policy/backoff golden | live recover only | none (cancel/race) | medium gap (TBE-011) |
| Credential store | decent (crypto 11, master_pw 27, mgr 11, auto_lock 10) | — | partial | ok-ish |
| Config expansion | broad, but **password untested** | — | none (password) | medium gap (TBE-013) |
| RDP sidecar framing | `MAX_MESSAGE_BYTES` cap exists | — | bounded (good) | ok |
| Local shell / serial / telnet | 42 / 22 / 29 tests | live | limited | ok-ish |

## Ignored / quarantined-test inventory

Hard `#[ignore]` / `cfg_attr(windows, ignore)` count = **18 tests**, plus a soft runtime-skip
pattern that silently green-skips the entire core integration suite.

| Where | Count | Mechanism | Runs on | Tracking | Finding |
|---|---|---|---|---|---|
| `agent/tests/local_agent_integration.rs` | 15 | `#[cfg_attr(windows, ignore="… #2495")]` | ubuntu+macOS only; Windows on-demand grade wf | #2495 OPEN | TBE-004 |
| `agent/tests/tcp_listener_readiness.rs:118` | 1 | `#[cfg_attr(windows, ignore="… #2495")]` | same | #2495 OPEN | TBE-004 |
| `core/src/backends/docker/mod.rs:1446,1513` | 2 | hard `#[ignore="requires live host"]` | **no lane** (manual `--ignored`) | — | TBE-005 |
| `core/tests/*` (SSH/VNC/FTP/telnet/docker/monitoring/net) | ~all (30 files) | `require_docker!` runtime skip → **green** | per-PR: `--no-run` only; else self-skip | by design | TBE-006 |

The `require_docker!` soft-skip is the most consequential: it is deliberately *not* `#[ignore]`
(comment: "runtime check instead of #[ignore]"), so it evades ignored-test counters and reports a
skipped fixture and a would-be-failing test as the same green.

## Systemic quality issues

1. **Dark integration lane carries the behavioral mass** (TBE-006, TBE-009). Per-PR CI proves the
   code *compiles*, not that it *works*. Three documented silent drifts shipped this way.
2. **Mock/real divergence → false green** (TBE-003). The mock is safer than reality on the exact
   axis that matters (size clamping), so tests can't reproduce the real vulnerability.
3. **Tests that encode bugs** (TBE-001). `defaults_exit_status_to_zero_when_unreported` asserts the
   buggy default; the mock channel can't even emit the missing message type.
4. **No adversarial concurrency fixtures** (TBE-008, TBE-011). Single-client, sequential, no
   `tokio::join!` contention, no `loom`, no timeout-as-deadlock-detector.
5. **No memory-safety net for `unsafe` FFI** (TBE-010). Plugin host is `unsafe` dlopen/dlsym with
   no Miri/ASAN lane; UAFs are undetectable by ordinary `cargo test`.
6. **No Rust coverage gate** (TBE-007); the advisory report is `continue-on-error`.
7. **Flake-by-construction** (TBE-012): real `tc netem` timing tests, wall-clock sleeps, and a
   whole bespoke concurrency-gate scaffold built to fight oversubscription instead of removing it.
8. **Missing hostile-input tests** across framing/parsing (TBE-002, TBE-003).

## Findings index

| id | sev | is_workaround | title |
|---|---|---|---|
| TBE-001 | critical | no | SSH exec ExitSignal untested; a unit test entrenches "signal = exit 0" |
| TBE-002 | high | no | NDJSON read_line unbounded, no hostile-input test |
| TBE-003 | high | no | VNC tests use a mock that clamps size; real resize does not |
| TBE-004 | medium | **yes** | 16 live-agent-TCP tests Windows-quarantined (#2495), no landed fix |
| TBE-005 | medium | **yes** | Docker/Podman `#[ignore]` tests run on no lane |
| TBE-006 | high | **yes** | `require_docker!` silent-skip → integration tests pass green when fixture absent |
| TBE-007 | high | no | No enforced Rust coverage gate (frontend has one) |
| TBE-008 | high | no | No multi-client concurrency test; agent AB-BA deadlock invisible |
| TBE-009 | high | no | Wire-contract + backend behavior covered only by dark integration lane |
| TBE-010 | high | no | Plugin FFI teardown/drop-order soundness untested (UAF invisible) |
| TBE-011 | medium | no | Reconnect/cancellation races have no fast unit tests |
| TBE-012 | medium | no | Timing/real-network/port-contention tests are flake-prone by construction |
| TBE-013 | medium | no | Password fields shell-expanded with no test pinning behavior |

## Is Rust backend coverage release-adequate?

**No.** Count is fine; structure is not. For a ventilator-grade release the systems layer (Rust) is
the one with (a) no coverage floor, (b) its most important tests on a lane that doesn't gate merges,
(c) mocks that hide the real vulnerability, (d) a test that encodes a live bug, and (e) zero
adversarial concurrency/FFI-soundness coverage — which is precisely why the cross-expert defects
(SSH exit-signal, VNC/NDJSON unbounded alloc, plugin UAF, agent deadlock, wire-contract drift)
exist un-caught. The remediation is mostly structural and high-leverage: pull limit/contract/
signal checks into per-PR unit tests, add Miri + a concurrency lane, gate the nightly integration
lane as release-blocking, and add a fail-on-decrease Rust coverage ratchet.
