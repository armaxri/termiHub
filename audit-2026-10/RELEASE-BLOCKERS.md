# termiHub — release-blocker synthesis (second audit, 2026-10)

Coordinator synthesis across all 38 audit angles (240 confirmed findings, `develop` @
`663465d52`). This is the judgment layer: what should gate a v0.1.0 release, how the
findings connect, and a suggested remediation order. Full detail lives in each
`audit-2026-10/<angle>/` folder; [`FINDINGS-INDEX.md`](./FINDINGS-INDEX.md) has the
per-angle table and the full high and medium lists.

termiHub is held to a safety-critical ("ventilator-grade") bar, so the ranking weighs, in
order: security and data safety, the app hanging or lying about session state, gate
integrity (whether green CI proves anything), and only then release mechanics and polish.

## Headline

The first audit's backlog clearly paid off. Against the same 38 angles the tree went from
**668 findings (7 critical, 139 high)** to **240 (0 critical, 6 high)**, and most of what
remains is medium/low hardening rather than broken features. But three things keep this from
being a clean release candidate:

1. **The plugin sandbox — the newest safety boundary — has a scope bypass.** A manifest
   path of `""` or `"."` grants whole-disk read/write through the host bridge while the UI
   says "no access to your files" (PLG2-001/SEC2-001).
2. **Global locks held across blocking I/O can freeze every tab.** One stalled tab or one
   slow agent connect stalls input, Ctrl+C, close and the main thread app-wide
   (TAURI2-001/CONC2-002, CONC2-001).
3. **The gates are dark again.** Scheduled lanes never fire because their workflow files are
   not on the default branch, `develop` has no required status checks, and the release gate
   skips the Rust supply-chain audit. Green CI currently proves less than it appears to
   (CI2-001..006 and restatements).

**15 findings are regressions** of first-audit fixes and **19 are incomplete** first-audit
fixes; those are listed in the index and deserve priority because they show where fixes do
not stick.

## The 6 highs

1. **PLG2-001 — Plugin filesystem scope bypass.** `filesystemPaths` is never validated;
   `""`/`"."` normalise to an empty root that `starts_with` every path, giving a sandboxed
   native plugin host-privileged read/write of `~/.ssh`, the vault, shell rc files and
   LaunchAgents (escape from the sandbox). Restated as SEC2-001. _(plugin-extensibility)_
2. **TAURI2-001 — One stalled tab freezes every tab.** `write_session`/`resize` hold the
   map-wide session mutex across blocking PTY/telnet/agent writes; a paste into a shell that
   is not reading stdin blocks input, Ctrl+C, close and session creation everywhere. #4092
   fixed the same pattern for close only. Restated as CONC2-002. _(backend-tauri-rust)_
3. **CONC2-001 — Agent connect holds the global agents mutex.** The whole SSH connect,
   keyboard-interactive prompt and an untimed `initialize` read run under one std mutex;
   sync main-thread commands (Disconnect, capabilities) and every agent-tab keystroke block
   behind it — up to 45 s, or unbounded while a prompt is open. _(concurrency-reliability)_
4. **PKG2-001 — v0.1.0 cannot be published from a tag.** The awk CHANGELOG range always
   comes back empty, the fallback dumps all ~7,800 commits (~642 KB) into the release body,
   which exceeds GitHub's 125,000-character limit, so `gh release create` fails. The
   security-release marker can never fire from CHANGELOG either. Regression of PKG-008.
   _(packaging-release)_
5. **PKG2-002 — Agent deploy to Windows hosts 404s.** The desktop requests
   `termihub-agent-windows-x64` (no `.exe`), which no release publishes, and dev builds ship
   no Windows agent at all. _(packaging-release)_
6. **PERF2-001 — Remote-desktop frames cross IPC as JSON number arrays.** One 1080p full
   frame is ~8 MB RGBA → ~30 MB of JSON plus large JS array copies; full frames are common
   (subscribe, reconnect, resize) and up to 256 MiB may be queued. _(performance)_

## Top 10 release blockers (ranked, grouped)

1. **Plugin sandbox integrity** — PLG2-001/SEC2-001 (scope bypass), SEC2-002/PLG2-005
   (trust acknowledgment bound only to the library hash, so an update can widen permissions
   and paths without new consent), PLG2-002 (a stale ack shows "trusted" while the plugin
   silently stays unloaded). The sandbox (ADR-19) is a headline safety claim; it must not be
   bypassable by manifest content.
2. **App-wide hangs from locks held across blocking I/O** — TAURI2-001/CONC2-002 (session
   map), CONC2-003 (agent-side sessions mutex across reattach/query_buffer). A terminal tool
   that freezes every tab because one tab stalled fails the safety bar.
3. **Agent connect/reconnect freezes and no-exit states** — CONC2-001 (agents mutex across
   connect + prompt), CONC2-004 (post-auth handshake has no timeout, so a reconnect can sit
   in "Reconnecting" forever), PARITY2-002 (VNC connect has no timeout and no cancel).
4. **Reconnect state that lies or cannot win** — SM2-001 (Disconnect/Shutdown of an agent
   sends every hosted tab into minutes of a reconnect loop that cannot succeed), SM2-002
   (agent-recovery folds ignore tab status: a user Stop is overwritten and an ended tab can
   come back; incomplete fix of SM-002), ARCH2-001 (redrive recreates sessions without the
   saved-connection binding or transfer-resume trigger), WA-FE2-002 (coordinated-update
   reconnect is one attempt after a hardcoded delay). Reconnect is the release's
   safety-critical path.
5. **Gates that do not gate** — CI2-001/TOOL2-001/WA-CI2-001/TFE2-002 (scheduled lanes in
   workflows not on `main` never fire: security audit, coverage, nightlies), CI2-004/CI2-005
   (coverage ratchet and lockfile chore have never run since #4119), CI2-002/WA-CI2-004
   (`develop` has zero required status checks; PR Gate is advisory), CI2-003/SUP2-001/
   WA-CI2-002 (release gate does not require cargo-deny/cargo-audit; agent binaries build
   without `--locked`), TIN2-001/TIN2-002/WA-CI2-003 (nightly bridge lanes can still skip
   whole suites silently and have no hang guard), TBE2-001 (agent-hosted tunnel E2E runs in
   no lane). Fixing this is the precondition for trusting any other fix.
6. **Data loss and destructive actions without confirmation** — PER2-003 (a failed
   master-password change leaves the vault re-keyed in memory, so the next save seals
   credentials under the "failed" password), ERR2-001 (VNC upload treats any stat failure as
   "name is free" and truncates an existing remote file), UX2-001..005 (closing a tab group,
   launching a workspace, closing a window/panel, dismissing editor dialogs and macOS Cmd+Q
   end sessions or discard unsaved work without the confirm), PER2-001/PER2-002 (agent
   connections store has no cross-process lock; macros/tunnels bypass the version gate),
   FES2-002 (moving a tab to another window skips teardown).
7. **v0.1.0 release mechanics** — PKG2-001 (release cannot be created), PKG2-003 (the
   documented `-beta.N`/`-rc.N` tag path cannot build: the MSI bundler rejects it),
   PKG2-004/CI2-006 (install smokes run after the release is published and marked latest,
   so they cannot gate users), PKG2-005 (the macOS right-click → Open bypass in every release
   body and the README no longer works on macOS 15+).
8. **Secrets and untrusted-input handling** — DUP2-001 (the VNC SSH-gateway `sshPassword`
   and plugin `format: password` fields are written in plaintext to `connections.json`,
   external files and backups), FEC2-001 (an imported run-script step's hidden `sourcePath`
   reads any local file and types it into the remote shell), AGT2-002 (coordinated agent
   update stages at a fixed, world-shared `/tmp` path and verifies by path — TOCTOU on the
   update path that the first audit hardened), FES2-001 (a second concurrent password prompt
   orphans the first; that connect hangs forever), I18N2-001 (stale sudo password never
   cleared because wrong-password detection reads English stderr), SUP2-002 (release SBOM
   job runs an unlocked `npx --yes` under write/attestation tokens).
9. **Windows agent deployment** — PKG2-002 (asset-name mismatch, no Windows agent in dev
   builds), PKG2-007 (the Windows arm64 agent is first built at tag time), DUP2-009 (the
   agent's self-update suffix map has drifted from the desktop's).
10. **Unbounded memory and throughput on untrusted streams** — PERF2-001 (frame encoding),
    PERF2-002 (no flow control from xterm back to the PTY; the frontend buffer grows without
    limit), AGT2-003/DUP2-002 (the desktop's agent NDJSON reader is still uncapped and
    quadratic — incomplete fix of AGT-013/DUP-009), AGT2-001 (non-ASCII text split across SSH
    chunks is corrupted), AGT2-004 (VNC/RDP-over-agent relays through unbounded queues),
    CORE2-002 (embedded FTP server accepts unbounded concurrent sessions), PERF2-004 (one
    WebGL2 context per tab; the oldest tabs lose WebGL for good past the cap).

## Cross-cutting themes

- **A. Fixes that do not stick.** 15 regressions and 19 incomplete fixes. Several are the
  same shape: a fix landed for one call site and the sibling was missed (TAURI2-001 vs #4092,
  SM2-002 vs SM-002, AGT2-003/DUP2-002 vs AGT-013/DUP-009, DUP2-004 TOKEN_USER alignment
  fixed in one copy only), or later work silently undid a fix (OBS2-001: `strip = true` made
  the OBS-002 crash backtraces unsymbolizable; PKG2-001 vs PKG-008). Each fix should carry a
  regression test that pins the behaviour, not the call site.
- **B. Lying feedback is still the most damaging UX failure.** PARITY2-001 ("Test
  connection" reports success for RDP without contacting the server), DEAD2-001 (the "Stop X
  server when idle" setting does nothing), DEAD2-002 (the "Session closed by server" state
  can never appear), PLG2-002 ("trusted" while unloaded), OBS2-006 (failed log Save/Copy
  looks like it worked), WA-FE2-004 (silent catch handlers have returned in new code).
- **C. Documentation contradicts the shipped safety model.** The README still says native
  plugins run in-process with full user privileges, contradicting ADR-19 and SECURITY.md
  (DOC2-001/MKT2-001/PROD2-003); it presents experimental features as available
  (MKT2-002/DOC2-004); `remote-protocol.md` omits nine RPC methods (DOC2-003/AGT2-006); and
  `plugin-authoring.md`'s own example manifest fails to load (PLG2-003). For a
  safety-critical tool, docs that overstate or understate isolation are a defect.
- **D. Accessibility gaps in core flows.** Ten medium a11y findings: unannounced
  connection-failure/session-lost overlays (A11Y2-002), mouse-only shortcut rebinding and
  drag reordering (A11Y2-001/003), a hand-rolled modal without dialog semantics
  (A11Y2-005/UISF2-001), and a remote-desktop canvas that captures all keys with an
  undisclosed escape chord (A11Y2-006).
- **E. Field diagnosability.** Release crash reports cannot be symbolized (OBS2-001), RDP
  sidecar logs and panics are lost in the bundled app (OBS2-003), and agent processes lose
  log lines across shared-file rotation (OBS2-002). After release these are the only
  evidence of a field failure.

## Strong foundations (don't regress these while fixing the above)

No critical finding in any angle. The first audit's criticals (agent update RCE and
unsigned updates, the no-exit reconnect, the missing persistence migration, the
substring-gated credential discard, the entrenched exit-signal bug, `--reruns` masking) did
not resurface as regressions; the only remainder is PER2-002 (macros/tunnels stores still
bypass the version gate PER-001 introduced). The credential store, host-key TOFU, signed agent and app
updates, the plugin OS sandbox itself (apart from the scope validation above), write-atomic
persistence with version gating in the main stores, the projection mechanism and the shared
UI primitive library all held up under verification.

## Suggested remediation order

1. **Security and data safety:** PLG2-001/SEC2-001 + the trust-ack binding (SEC2-002/
   PLG2-005), PER2-003, DUP2-001, FEC2-001, AGT2-002, ERR2-001.
2. **Hangs and reconnect:** take backend I/O out from under the session-map and agents
   locks (TAURI2-001/CONC2-002, CONC2-001, CONC2-003), bound every handshake step
   (CONC2-004, PARITY2-002), then fix the agent reconnect state folds (SM2-001, SM2-002,
   ARCH2-001) with fold-level regression tests.
3. **Make the gates real before trusting step 1–2:** get the scheduled workflows onto
   `main` (or switch their triggers), make PR Gate a required check on `develop`, require the
   Rust supply-chain audit on the release commit, make nightly skips fail loudly, and move
   install smokes before mark-latest.
4. **Unblock v0.1.0:** PKG2-001 (tested CHANGELOG extraction + capped fallback), PKG2-003,
   PKG2-002 (single asset-name function + contract test + Windows dev-build legs), PKG2-005.
5. **Confirmations and lying feedback:** UX2-001..005, Theme B.
6. **Throughput and memory:** PERF2-001 (binary channel or base64 frames), PERF2-002,
   AGT2-003/DUP2-002 (one capped NDJSON reader in `core`), AGT2-004, AGT2-001.
7. **Docs, accessibility, diagnostics, then the remaining medium/low findings and the 23
   `is_workaround: true` items** as the "release without workarounds" checklist.
