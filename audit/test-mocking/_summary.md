# Mocking / fixtures / test-doubles fidelity — audit summary

**Angle:** test-mocking · **Id prefix:** MOCK · **Date:** 2026-09-10

The coverage experts asked *"what is tested?"*. This angle asks *"are the doubles honest,
and does the test infrastructure leak into production?"* Low-fidelity or misused doubles
produce the worst failure mode for a safety-critical release: **green tests over broken
reality**. It deepens, rather than repeats, the mock notes already in `test-backend`
(TBE-001/003/009) and `test-frontend` (TFE-003/004/009).

## Headline

The suite is broad and mostly disciplined, but its doubles fail in the **dangerous
direction** in several places — the mock is simpler, safer, or narrower than the thing it
stands in for — and, more seriously, **two test doubles ship in the production binary** and
are runtime-activatable. The single worst pattern: the app's most reliability-critical
surfaces (Terminal state machine, IPC boundary, graphical pipeline, reconnect logic) are each
verified against a hand-kept double whose contract diverges from the real dependency, so an
upstream/backend change degrades silently with no test signal.

## Test-doubles inventory + fidelity rating

| Double | Where | Stands in for | Fidelity |
|---|---|---|---|
| `MockRemoteDesktop` | core/backends/mock_remote_desktop.rs | real VNC/RDP graphical backend | **divergent-dangerous** — clamps size (`MAX_DIMENSION 1920`), bounded channels; **and it ships** (MOCK-001, MOCK-011) |
| TestBridge + `test_sever_agent_transport` | src/testbridge, src-tauri commands/agent | E2E driver | **leaks to production** — runtime-enableable remote control (MOCK-002) |
| `MockXTerm` ×15 | Terminal/*.test.tsx | `@xterm/xterm` | **divergent** — no `_core`; 15 hand-kept copies drift (MOCK-003) |
| Global `invoke` mock | src/test/setup.ts, api.test.ts | Tauri IPC + Rust DTOs | **divergent** — assert-on-mock, response never decoded (MOCK-005) |
| `MockChannel` (ssh exec) | core/backends/ssh/exec.rs | ssh2 exec channel | **divergent** — `ExecEvent` vocabulary omits signal-exit (MOCK-006) |
| monaco / shiki stubs | src/test/setup.ts | monaco-editor, shiki | **simplified** — no-op registration, hard-coded language list (MOCK-007) |
| jsdom FileBrowser overrides + scroll shim | src/test/setup.ts | browser layout/scroll | **divergent + workaround** — constant size; masks a leaked timer (MOCK-008) |
| `FakeTransport` / `MockAgentRpcClient` / `FakeAgent` | core ssh/monitoring, src-tauri | real transports | **simplified** — clean Ok/Err + canned payload, no degraded middle (MOCK-009) |
| `fake_app.py` | tests/system | in-app bridge dispatcher | **divergent** — hand-kept Python re-impl of TS dispatcher (MOCK-010) |
| `mockData.ts` | src/store | sample connections | **dead** — unreferenced fixture, drift risk (MOCK-004) |
| SSH key fixtures | tests/fixtures/ssh-keys | real keys | **faithful** — real generated keys, clearly labelled test-only (no finding) |

## Test doubles that leak into the production build

1. **`mock-remote-desktop`** — in `src-tauri` `default` features (`Cargo.toml:18`); registered
   as a live, user-selectable connection type behind the runtime experimental toggle
   (MOCK-001). `is_workaround: true`.
2. **TestBridge + `test_sever_agent_transport`** — mounted unconditionally
   (`TerminalView.tsx:443`), command registered in the default IPC handler (`lib.rs:1480`),
   both activatable at runtime in a shipped build via `localStorage`/URL/global — not only the
   build flag (MOCK-002). `is_workaround: true`.
3. **`mockData.ts`** — dead sample fixture left in `src/` (MOCK-004). `is_workaround: true`
   (unused scaffolding to remove).

## Top risks (ranked)

1. **MOCK-002 (high)** — TestBridge remote-control + agent-sever hook ship in production and
   are runtime-enableable; it is attack surface, not just dead code.
2. **MOCK-001 (high)** — a pure test-pattern backend is in the default build and offered as a
   connection type.
3. **MOCK-003 (medium)** — Terminal state machine tested only via 15 drifting `MockXTerm`
   copies with no `_core`; the app's headline reliability code has the least honest double.
4. **MOCK-005 (medium)** — IPC layer asserted-on-mock; backend DTO drift invisible.
5. **MOCK-011 (medium)** — graphical pipeline exercised only against the bounded mock; real
   VNC oversize-alloc path unreachable by any gating test.
6. **MOCK-006 / MOCK-009 (medium)** — doubles structurally narrower than reality (no
   signal-exit; no degraded transport), so whole failure classes are untestable.
7. **MOCK-008 (medium)** — infra-level fidelity hacks; one masks a real leaked timer.
8. **MOCK-010 (medium)** — harness validated against a duplicate Python protocol impl.
9. **MOCK-007 / MOCK-004 (low)** — stubbed grammar path; dead fixture.

## Findings index

| id | sev | is_workaround | title |
|---|---|---|---|
| MOCK-001 | high | yes | Mock remote-desktop test backend ships in the DEFAULT build, user-selectable |
| MOCK-002 | high | yes | TestBridge + `test_sever_agent_transport` ship in production, runtime-enableable |
| MOCK-003 | medium | no | `MockXTerm` duplicated across 15 files, omits `_core`; private path never exercised |
| MOCK-004 | low | yes | `src/store/mockData.ts` is a dead, unreferenced fixture (drift risk) |
| MOCK-005 | medium | no | Global `invoke` mock: IPC asserted-on-mock, real DTO never decoded |
| MOCK-006 | medium | no | SSH exec `MockChannel` can't express signal-exit (narrower than reality) |
| MOCK-007 | low | no | monaco/shiki fully stubbed; grammar-registration path dark |
| MOCK-008 | medium | yes | jsdom fidelity hacks + leaked-timer workaround diverge from real browser |
| MOCK-009 | medium | no | Rust fakes model clean Ok/Err + canned payload, not degraded reality |
| MOCK-010 | medium | no | Python harness self-tested against `fake_app.py` re-impl of the TS dispatcher |
| MOCK-011 | medium | no | Graphical E2E runs only against the intentionally-bounded mock |

## Cross-references (do not re-file)
- TBE-001 (SSH exec entrenches signal=exit-0) — root cause is MOCK-006's mock vocabulary.
- TBE-003 (VNC mock clamps, real doesn't) — MOCK-011 is the integration-level counterpart.
- TBE-009 (wire contract dark) — MOCK-005 is the frontend side of the same unbound contract.
- TFE-003 (xterm `_core`) / TFE-004 (assert-on-mock) — deepened by MOCK-003 / MOCK-005.
