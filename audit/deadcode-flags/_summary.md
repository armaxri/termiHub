# Dead-code & feature-flag hygiene — audit summary

Angle: **deadcode-flags** · Scope: `src/store/**`, feature flags (frontend runtime,
Cargo features, env gates), `core`/`src-tauri`/`agent` dead modules, post-inversion residue.

**Overall read:** the projection/reducer inversion cleaned up well — 10/11 frontend
domains deleted their local reducers and their `window.__TERMIHUB_*__` migration flags
are gone. What remains is a *small, well-bounded* pile of cruft, concentrated in three
places: (1) **layout**, the one genuinely half-migrated domain (dual authority, tracked
#2562); (2) **test/scaffolding compiled into the release build** (mock backend in default
features; test-bridge + its now-orphaned flag-injection); (3) **write-only / orphaned
frontend state** left by the old remote-state and event-dispatcher paths. None is
release-blocking on its own, but together they are exactly the "no dead paths, no
scaffolding" cleanup this release wants. **13 findings.**

## Feature-flag inventory

### Cargo features — `src-tauri` (`default = ["ftp","mock-remote-desktop","vnc","rdp-sidecar"]`)

| Flag | Gates | Default | Correct for release? |
|------|-------|---------|----------------------|
| `ftp` | FTP/FTPS connection type | on | ✅ real feature |
| **`mock-remote-desktop`** | protocol-less test/demo graphical backend | **on** | ❌ **DEAD-001** — test scaffold ships (experimental-gated in UI but present) |
| `vnc` | VNC (RFB) backend | on | ✅ real; hidden behind experimental toggle (#1705) |
| `rdp-sidecar` | RDP via IronRDP sidecar | on | ✅ real; experimental-gated; sidecar bundled |

### Cargo features — `core` (`default = []`, consumers select)

`embedded-servers`, `plugin`, `http-monitor`, `serial`, `local-shell`, `telnet`, `ssh`,
`docker`, `wsl`, `ftp`, `mock-remote-desktop`, `vnc`, `rdp-sidecar` — all additive
dependency-gates, default-off, selected by `src-tauri`/`agent`. ✅ correct. (`core`'s
`mock-remote-desktop` is just the impl; the release exposure is the `src-tauri` default above.)

### Runtime env-var gates

| Env var | Purpose | Ships in release? | Correct? |
|---------|---------|-------------------|----------|
| `TERMIHUB_TEST_BRIDGE_PORT` | activates WebSocket test bridge | compiled in, inert unless set | ⚠️ **DEAD-002** — module not `cfg`-gated; includes a CSP-relaxation path |
| `TERMIHUB_TEST_FLAG_*` → `window.__TERMIHUB_<NAME>__` | flip a runtime flag for a live grade (#2476) | compiled in | ❌ **DEAD-003** — **no frontend consumer left**; fully orphaned |
| `TERMIHUB_TEST_NO_ALWAYS_ON_TOP` | test-window occlusion opt-out (#2504) | compiled in (bridge-only) | ⚠️ tied to DEAD-002 |
| `TERMIHUB_FILE_LOG`, `TERMIHUB_BUILD_BRANCH`, `TERMIHUB_AGENT_UPDATE_*`, `TERMIHUB_RDP_HELPER[_SHA]` | diagnostics / config / sidecar path | yes | ✅ legit |
| `TERMIHUB_TEST_{SSH,FTP,DOCKER,SERIAL,TELNET}_*` | integration-test targets | read only in test code | ✅ legit |

### Frontend runtime flags

| Flag | Gates | State | Correct? |
|------|-------|-------|----------|
| `experimentalFeaturesEnabled` (setting) | graphical remote-desktop types (mock/VNC/RDP) | user setting | ✅ real |
| experimental frontend-plugin gate (#2048) | plugin surfaces | user setting | ✅ real |
| `resolveFeatureEnabled` (`enableMonitoring`/`enableFileBrowser`) | per-connection overrides | live | ✅ real |
| `window.__TERMIHUB_*__` migration flags (`sessionBackendReattach`, render/mutation cuts) | — | **all removed** | ✅ migration complete (see DEAD-003 for the dead backend half) |

**Flags in the WRONG state for release:** `mock-remote-desktop` in `src-tauri` default
(DEAD-001); test-bridge always-compiled (DEAD-002); the orphaned `TERMIHUB_TEST_FLAG_*`
injection mechanism (DEAD-003). All marked `is_workaround: true`.

## Dead-code inventory by subsystem

**Frontend store / services (`src/store`, `src/services`, `src/hooks`)**
- DEAD-006 — `appStore.remoteStates`: write-only map, fed on every session event, never read.
- DEAD-007 — `events.ts` `subscribeRemoteState`/`subscribeAgentState` + `remote-state-change`/`agent-state-change` listeners: no consumers.
- DEAD-005 — `layoutBridge.composeRenderTree()`: unused; `viewMatchesTree` `{@link}`s dangle.
- DEAD-008 — `useTauriEvents()`: empty Phase-1 stub, never imported.
- DEAD-009 — `src/store/mockData.ts`: unreferenced sample data.

**Frontend↔backend layout migration**
- DEAD-004 — layout dual authority (local reducers + optimistic overlay + gated instant-revert fallback), the one half-migrated domain (#2562).

**Backend Rust (`core`, `src-tauri`)**
- DEAD-010 — `OutputCoalescer::try_coalesce()`: never called in production.
- DEAD-012 — `shell_integration` resolve API (`ResolvedConnection`/`resolve_connection`/`resolve_entry`): landed ahead of a never-shipped CLI-spawn consumer (#1363).
- DEAD-013 — `#[allow(dead_code)]` inventory: dead error variants, speculative agent version/protocol fields, `AgentRpcClient` trait, layout rollback `snapshot`, and the legitimate RAII/platform/test cases.
- DEAD-011 — stale "Shadow / not authoritative" doc headers on the migrated projection modules (overlaps docs-accuracy DOC-001).

## Top items to remove before release (ranked)

1. **DEAD-001** — drop `mock-remote-desktop` from `src-tauri` default features (test backend out of the shipped product). *Low-risk, high-signal.*
2. **DEAD-004** — finish the layout migration (#2562): single authority, delete the fallback/overlay scaffolding. *Largest remaining complexity; needs parity tests, not a raw delete.*
3. **DEAD-003** — delete the orphaned `TERMIHUB_TEST_FLAG_*` injection mechanism (no consumer).
4. **DEAD-002** — `cfg`-gate the test-bridge (and its CSP-relaxation) out of the release binary.
5. **DEAD-006 + DEAD-007** — remove the remote-state write-only map and the dead event-dispatcher subscribers (do together).
6. **DEAD-005 / DEAD-008 / DEAD-009 / DEAD-010** — small proven-dead deletes (unused compose fn, stub hook, mock data file, dead coalescer method).
7. **DEAD-012 / DEAD-013** — decide #1363's scope; trim the speculative `#[allow(dead_code)]` items.
8. **DEAD-011** — refresh the projection module docs (coordinate with docs-accuracy).

## How much cruft is left
**Modest and contained.** The migration did the hard part. Excluding layout (DEAD-004,
which is deferred by design), the rest is straightforward proven-dead deletion —
roughly a dozen small removals plus two feature-flag defaults to flip. No sign of large
abandoned subsystems or duplicated-then-orphaned implementations beyond what is listed.
