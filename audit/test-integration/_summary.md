# Integration / E2E / Test-Harness audit — summary

**Angle:** integration, end-to-end, and test-harness. **Id prefix:** `TIN`.
**Findings:** 17 (1 high-structural, 1 high-gap, plus mediums and one low/info).

## The landscape

termiHub has an unusually mature test-harness for its stage. The system/E2E layer
is a **Python bridge harness** (`tests/system/`, ~91 suites) that launches the
real built app and drives it over an in-process WebSocket bridge — crucially,
this works on **macOS** too, where `tauri-driver` never had a WKWebView driver.
Real backends are exercised by ~20 Docker fixtures (`tests/docker/`) and by
`require_docker!`-gated `core/tests` Rust suites. A **nightly integration lane**
(`system-integration.yml`) builds the app and runs the whole thing on all three
OSes; a separate `integration-fixtures.yml` runs `core/tests` against live
fixtures. The recent nightly-green campaign, the automation of the reconnect grade
(replacing a false-passing manual harness), and the deterministic in-process
`severAgentTransport` verb are all genuine strengths.

The problems are almost all about **where the coverage runs**, not whether it
exists.

### Journeys × coverage

| Journey / backend | Per-PR | Nightly (Linux) | Nightly (mac/Win) | Manual | Notes |
| --- | --- | --- | --- | --- | --- |
| App launch + UI (CSP, terminal, editor, sidebar, split) | ✗ | ✓ | ✓ | — | dark per-PR (TIN-001) |
| SSH (auth, exec, monitoring) | ✗ | ✓ | ✗ (skip) | partial | Linux-only backend (TIN-007) |
| SFTP transfers | ✗ | ✓ | ✗ | — | Linux-only |
| FTP transfer queue (resume/pause) | ✗ | ✗ | ✗ | ✓ | live test deferred (TIN-015) |
| Serial | ✗ | ✓ (virtual/socat) | mac ✓ / Win ✗ | ✓ live I/O | real serial manual (TIN-015) |
| Telnet | ✗ | ✓ | ✗ | — | |
| Docker backend | ✗ | partial | ✗ | partial | agent Docker tests skip everywhere (TIN-008) |
| VNC | ✗ | ✓ backend only | ✗ | ✓ paint | no E2E/UI (TIN-006) |
| **RDP** | ✗ | ✗ | ✗ | ✓ only | **zero automated coverage (TIN-005)** |
| Agent (deploy, update, reconnect) | ✗ | ✓ | reconnect: mac✓/Win✗ | Win-over-SSH manual | Win live-agent-TCP quarantined (TIN-009) |
| SSH tunnels | ✗ | ✓ | mac skip | — | macOS carve-out #933 |
| Reconnect (agent) | ✗ | ✓ (automated #2574) | mac✓/Win✗ | — | direct/monitoring reconnect weaker |
| **Workspace/layout restore** | ✗ | ✗ | ✗ | ✗ | **no coverage at all (TIN-013)** |
| **Multi-window** | ✗ | ✗ | ✗ | ✓ only | harness not multi-window aware (TIN-014) |
| Drag/split gestures, native input/IME | ✗ | component-only | — | ✓ | synthetic events only (TIN-017) |

## Top risks (release-relevance order)

1. **The whole integration/E2E lane is dark per-PR (TIN-001).** Per-PR CI runs
   `-m "not integration"` against a FakeApp + `cargo test` with no Docker. Every
   real-app and real-backend suite is merely *collected/compiled*, never *run*,
   until the nightly. This is the structural cause of the three shipped
   app/harness drift bugs, and it is still the shape today.
2. **The nightly — the only real net — masks failures (TIN-002).** It retries
   every failed test **4×** (`--reruns 4`, though comments say `2`) and scales all
   waits 2×, so a test passing 1-run-in-5 greens the lane. The detector is blunted
   with a flake-mask.
3. **RDP has zero automated coverage (TIN-005)** and **workspace restore has none
   at all (TIN-013)** — two significant features guarded only by prose/humans.
4. **Backend journeys are verified on one OS (TIN-007).** Docker fixtures are
   Linux-only, so macOS/Windows nightly legs run no real-backend suites; "green on
   three OSes" overstates parity. Compounded by the Windows live-agent-TCP
   quarantine (TIN-009) and agent Docker tests skipping everywhere (TIN-008).
5. **Test surface leaks into release (TIN-003 + TIN-004).** The full bridge
   dispatcher is compiled into the production bundle and runtime-activatable via
   localStorage/URL; and the shipped **production CSP is never exercised** because
   the integration lane builds with a loosened test CSP overlay.

## What ships unverified per-PR

Everything that isn't a unit/machinery test: the real app never launches, no
backend is touched, no testid selector is behavior-checked (TIN-012), no CSP boot,
no reconnect/transfer/tunnel journey. A PR that renames a testid, changes a Tauri
command or projection intent, breaks a real connect, or regresses the production
CSP gets **green CI**; the break surfaces up to ~24h later in the nightly (or, for
RDP/workspace/multi-window, only when a human runs the manual matrix).

## Is the integration story release-adequate?

**Not yet, but the foundation is strong and the gaps are addressable.** The bridge
harness is a real asset and the nightly lanes are well-engineered. The blockers for
a confident release are: (a) shrink the per-PR dark window so drift fails on the PR
(a thin per-PR bridge smoke + testid-reference check + path-triggered integration),
(b) stop the nightly from masking regressions (cut `--reruns`, quarantine-not-retry),
(c) close the two zero-coverage features (RDP TIN-005, workspace restore TIN-013),
and (d) exclude the test bridge from release by build and regression-test the
production CSP (TIN-003/004). The remaining items (multi-window, native input,
manual grades, container hygiene, dev.local fragility) are important but can ride a
tightened release checklist while automation lands.

## Finding index

| Id | Sev | WA | Title |
| --- | --- | --- | --- |
| TIN-001 | high | | Whole integration/E2E lane is dark per-PR |
| TIN-002 | high | ✓ | Nightly retries failures 4× + scales waits 2× — masks flakes/regressions |
| TIN-003 | med | | Test-bridge dispatcher ships in production bundle, runtime-activatable |
| TIN-004 | med | ✓ | Production CSP never exercised (integration builds a loosened test CSP) |
| TIN-005 | high | | RDP has zero integration/E2E coverage — manual-only |
| TIN-006 | med | | VNC covered only at backend/RFB level, Linux-nightly-only — no E2E/UI |
| TIN-007 | med | | Docker fixtures Linux-only → backends verified on one OS |
| TIN-008 | med | | Agent crate's Docker integration tests self-skip in every CI lane |
| TIN-009 | med | ✓ | 16 Windows live-agent-TCP tests quarantined behind open #2495 |
| TIN-010 | med | | No macOS/Windows release-install smoke; macOS smoke = window-exists only |
| TIN-011 | med | | Harness never tears down fixtures; app-spawned containers can orphan |
| TIN-012 | med | | Testid drift caught only by coverage check + nightly, not per-PR behavior |
| TIN-013 | med | | Workspace/session-layout save-restore has no test coverage |
| TIN-014 | med | | Multi-window is manual-only; bridge not multi-window aware |
| TIN-015 | med | ✓ | ~100 manual items remain, several release-gating |
| TIN-016 | low | | Parallel-isolation scheme collides silently on missing dev.local.json |
| TIN-017 | med | | Synthetic DOM events — native input, IME, key drag gestures uncovered |
