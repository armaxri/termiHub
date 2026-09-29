# termiHub — release-blocker synthesis

Coordinator synthesis across all 38 audit angles (668 findings). This is the judgment
layer: what should gate a v0.1.0 release, the cross-cutting themes, and a suggested
remediation order. Full detail lives in each `audit/<angle>/` folder;
`FINDINGS-INDEX.md` has the complete per-angle table and the full critical/high list.

## Headline

The product is **more mature than a typical pre-v0.1.0** — SSH/tunnels/agents/session-
restore/plugins/themes are real and largely done, RDP/VNC are genuine implementations,
and several foundations are genuinely strong (credential crypto, terminal-output hot
path, the projection *mechanism*, `core` centralization, host-key TOFU, write-atomic
persistence). The blockers are **not** "it doesn't work" — they cluster into a small
number of systemic themes, most of which are removal/consistency work rather than
rewrites.

7 critical, 139 high. **154 findings are explicit workarounds** to remove before a
clean release.

## The 7 criticals

1. **AGT-003 — Agent update is RCE-as-agent.** Any client that finishes `initialize`
   (any SSH principal) can call `agent.request_update{binaryPath}` with an arbitrary
   path; the agent copies it over its own executable and re-execs. Host-wide code
   execution. *(agent-protocol)*
2. **AGT-004 — The update apply path verifies nothing.** SHA-256 exists only in the
   self-update *download*; pushed/staged routes swap unverified bytes, and the checksum
   comes from the same channel as the binary (no signature anywhere). *(agent-protocol)*
3. **SM-001 — No-exit "Reconnecting…".** When an agent transport reconnects but the
   follow-up `connection.list` returns None, tabs fold to a timer-less phase and the UI
   shows "Reconnecting" forever; only manual Stop escapes. The exact stuck-state class a
   reconnect-critical release must eliminate. *(state-machine-ux)*
4. **PER-001 — No schema-migration mechanism for any persisted store.** Every store
   writes a `version` field that is never read; there is no `migrate()` and no downgrade
   safety, so a version bump on an auto-updating app can silently drop or wipe user data.
   *(persistence-migration)*
5. **I18N-001 — Destructive credential discard gated on an English substring.**
   `removeCredential` fires on `raw.includes("auth failed")`; a localized/remote/reworded
   message deletes a valid credential or traps the user. *(i18n; same root as ERR-003)*
6. **TBE-001 — A unit test entrenches a real bug.** SSH exec reports a signal-killed
   command as exit 0 (success), and the test suite *asserts* that default while the mock
   channel can't even emit a signal — so the bug is structurally un-catchable.
   *(test-backend; the bug itself is CORE-004)*
7. **CI-002 — `--reruns 4` masks the only automated reconnect grade.** A 1-in-5 pass
   greens `test_agent_reconnect_ui`, the sole automated test of the safety-critical
   reconnect path — opposite of the repo's own "quarantine-not-retry" rule. *(ci-cd)*

## Cross-cutting themes (these connect dozens of findings)

- **A. Test/dev scaffolding compiled into the release binary.** The `mock-remote-desktop`
  backend ships in the *default* cargo features as a user-selectable connection type, and
  the **TestBridge** (with a CSP relaxation) compiles into release, runtime-activatable in
  a shipped build via localStorage/URL/global to read terminal buffers and inject
  keystrokes. Flagged independently by product, parity, security, mocking, packaging,
  dead-code. *(PROD-066, PARITY-009, SEC-005, MOCK-001/002, PKG-001/002, DEAD-001/002)*
- **B. The update path is unsigned and unverified, end to end.** App + agent updates trust
  a same-channel checksum, never a signature; CI publishes releases before assets exist
  and ships unsigned/ad-hoc-signed bundles. A compromised release = trojaned client/agent.
  *(AGT-004/005, SEC-006, PKG-003, SUP-009, CI-007/008, WA-CI-018)*
- **C. Silent failure / "lying" feedback.** ~40–45 swallowed frontend catches, no frontend
  ERROR log channel, "success" toasts on no-op transfer controls, stringly-typed IPC
  errors sniffed by English substring (gating a *destructive* action), swallowed SSH
  env/X11 errors, no panic/crash hook. A connection tool that says "it worked" when it
  didn't is the most damaging failure mode. *(UX-016/033, ERR-001/002/003, OBS-001/002,
  WA-FE-005)*
- **D. Reconnect/state legibility, modeled inconsistently.** Reconnect is modeled 3+ ways
  with opposite defaults; a lying tab status-dot; monitoring frozen "stale-as-live"; the
  non-cancellable reconnect connect; the agent AB-BA deadlock; cross-desktop session
  eviction. Converging every per-session status on the authoritative lifecycle region is
  the highest-leverage fix. *(SM-001/011/012/020, CONC-001/002/003, AGT-015, PARITY-008)*
- **E. The test *gates* don't actually gate.** Integration/E2E is dark per-PR; the nightly
  masks with `--reruns 4`; mocks are safer/narrower than reality exactly where reality is
  dangerous; no unified/whole-app coverage number; no Rust coverage gate; `release-check.sh`
  (incl. the TODO/HACK scan) is wired into no lane. Green CI does not prove the risky paths.
  *(TIN-001/002, TBE-003/006, MOCK-*, TOOL-001/002/003, CI-*, WA-CI-004/029/030)*
- **F. Untrusted-input robustness gaps.** Unbounded allocation on server-controlled sizes
  (VNC framebuffer, NDJSON line length) → OOM abort across the agent trust boundary; HTTP
  listing XSS; HTTP-monitor SSRF; plugin FS sandbox is lexical-only (symlink escape);
  plugin teardown use-after-free. *(CORE-002/008, SEC-002/003/007/008, CORE-029/030)*
- **G. No i18n on the *machine* side is a live-bug source, not just translation debt.**
  Classifying transport/OS/agent errors and parsing container output by English substring
  means a non-English remote/OS/container silently breaks real features today (credentials,
  Docker file browsing). Force `LC_ALL=C` on parsed commands + structured error codes.
  *(I18N-001..005, ERR-003)*

## Migration-status reconciliation (an audit-wide disagreement, resolved)

Several backend experts (architecture, tauri) read the projection/reducer inversion as
**half-migrated / dual-authority**, while the frontend-state expert read it as **10/11
domains done**. The docs-accuracy and dead-code experts resolve it: **the migration is
largely complete**, but the backend `*_projection` module headers and `lib.rs` comments
still say *"Shadow… not yet driving the live UI,"* which is stale and actively misled the
other experts. **Layout is the one genuine half-migrated outlier** (#2562: local reducers +
optimistic overlay + unused compose fns). Action: fix the stale headers (DOC-001/DEAD-011,
one edit), finish the layout cut with the parity-test-then-cut treatment the other 10 got,
and delete the orphaned remote-state residue (`remoteStates`, dead listeners).

## Strong foundations (don't regress these while fixing the above)

Credential store (Argon2id + AES-256-GCM + zeroize + 0600); host-key TOFU + MITM warning;
no command injection; no frontend XSS sinks; the terminal-output hot path; `core` genuinely
centralizes shared algorithms for app+agent; the projection mechanism itself; write-atomic
persistence with `.bak` recovery (2 stores excepted); the shared UI primitive library and
token discipline; reduced-motion handling; the Python bridge harness that drives WKWebView.

## Suggested remediation order

1. **Security/data-loss criticals first:** AGT-003/004 (gate agent update off + sign),
   PER-001 (+ downgrade safety), the untrusted-input allocation caps (Theme F).
2. **Strip release scaffolding (Theme A):** feature-gate mock backend + TestBridge + CSP
   relaxation out of release; make `release-check.sh` a real gate.
3. **Reconnect + silent-failure (Themes C/D):** kill SM-001's stuck state, add a frontend
   error channel + panic hook, converge session status on the lifecycle region, replace
   substring error-sniffing with structured codes (also closes I18N-001).
4. **Make the gates real (Theme E):** un-mask `--reruns`, add a per-PR integration smoke +
   contract/limit unit tests, unified coverage gate (the tooling-coverage proposal), fix
   the `.tsx` coverage blind spot, delete the test that entrenches TBE-001/CORE-004.
5. **Presentation + docs before public launch:** README undersell + Docker oversell,
   screenshots, RDP/VNC discoverability, stale/contradictory docs, licensing sign-off.
6. **The 154 workarounds:** work `audit/workaround-*` + every `is_workaround: true` as the
   explicit "release without workarounds" checklist.
