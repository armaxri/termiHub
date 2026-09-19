# Documentation Accuracy — audit summary

**Angle:** docs-accuracy (documentation-correctness lens; marketing/positioning is a separate angle)
**Scope:** README, docs/**, SECURITY.md, CHANGELOG.md, THIRD_PARTY_LICENSES.md, in-repo CLAUDE.md/.claude,
architectural code comments, examples/**.
**Findings:** 13 (id prefix `DOC`). Method: for each significant doc claim, spot-checked against the
code (directly + via parallel code-verification sweeps), citing both the doc and the contradicting code.

## Overall read

The docs are unusually thorough and mostly well-maintained, but they lag the code in three predictable
ways: (1) the completed **stateless-UI/reducer-inversion migration** left the backend's own module
headers describing the *opposite* of what the code now does; (2) the **VcXsrv-via-winget switch (#1318)**
was applied to `THIRD_PARTY_LICENSES.md` but not to `docs/licensing.md`, which still describes
redistribution and points at a deleted file; and (3) the **README under-describes the shipped product**
(no RDP/VNC/FTP, no plugin system, no on-launch update-check/telemetry note, a wrong Close-Tab shortcut,
and two broken example command paths). None are crashes, but for a safety-critical release where a wrong
doc is itself a defect, the architecture- and licensing-level contradictions are release-relevant.

Nothing contradicted here is a fabricated feature — every shipped subsystem I checked (RDP/VNC/FTP,
plugins, update-check, the test bridge, protocol negotiation on the agent) is real. The gaps are
docs that lag, over-claim, or omit.

## Doc-health map

| Doc | State | Notes |
| --- | --- | --- |
| README.md | **contradicted + missing** | Omits RDP/VNC/FTP, plugin system, update-check; wrong Ctrl+W shortcut; broken example paths; Windows-X11 claim conflicts other docs. Install/first-run/Gatekeeper/SSH/serial guidance is good. (DOC-003/007/008/009/011) |
| docs/licensing.md | **contradicted** | Says termiHub redistributes VcXsrv; refs non-existent `acquire.rs`/`PINNED_VCXSRV`; unchecked counsel gate on a removed path. (DOC-002) |
| THIRD_PARTY_LICENSES.md | mostly accurate | Correctly states winget/no-redistribution, but repeats the dead `acquire.rs`/`PINNED_VCXSRV` reference. (DOC-002) |
| src-tauri/src/*_projection headers + lib.rs | **contradicted** | Still "Shadow … not yet driving the live UI / not authoritative" after the migration; internally contradictory. (DOC-001) |
| docs/audits/*state-machine*.md (×8) | **stale** | Frozen #113x snapshots with `file:line` refs and reducer descriptions the migration invalidated; not marked historical. (DOC-004) |
| docs/remote-protocol.md | partly accurate | Version negotiation/compat matrix real on the agent; desktop sends stale `0.3.0` and does no validation. (DOC-010) |
| docs/testing.md | mostly accurate | ">80% Rust coverage" target has no measuring tooling. (DOC-005) |
| docs/contributing.md | mostly accurate | Version-bump commits 3 of 4 files; "self-update" misnomer for the notify-only update-check. (DOC-011/012) |
| CHANGELOG.md | **stale/uncurated** | `[0.1.0]` is raw per-PR dev churn, contradicting contributing.md's curation rule. (DOC-012) |
| docs/release-plan-0.1.0.md | **stale** | References the retired tauri-driver full E2E suite; superseded process. (DOC-013) |
| .github/workflows/system-integration.yml | minor stale | `--reruns 2` comments vs actual `--reruns 4`. (DOC-006) |
| docs/keyboard-shortcuts.md | accurate | Matches code; README is the one that disagrees with it. |
| docs/test-bridge.md | accurate | Honestly documents env-gated bridge ("production launch can never" enable it). |
| SECURITY.md | accurate | Reporting policy; note it is not a user threat model (that gap is in the README — DOC-011). |
| docs/plugin-authoring.md | accurate + honest | Carries a "may not be present in every build" disclaimer; system is in fact shipped/enabled. |
| examples/** (config, plugin manifests, serial README) | accurate | connections.json + manifests match current schemas; nested READMEs use correct paths (README top-level is the outlier). |

## Top contradictions (code-vs-doc)

1. **DOC-001 (high)** — Backend `*_projection` module headers + `lib.rs` still say "Shadow … not yet
   driving the live UI / not authoritative" although the reducer-inversion migration made the regions
   authoritative. Provably stale (sibling files in broadcast/workflow/restore_cohort already say "now
   driving"). Mis-describes the core architecture for every domain.
2. **DOC-002 (high)** — `docs/licensing.md` still claims termiHub redistributes the VcXsrv binary and
   carries GPL-3.0 distribution obligations; code installs via winget (#1318). Refs a deleted file
   (`src-tauri/src/terminal/xserver/acquire.rs`) and constant (`PINNED_VCXSRV`), and a release-gating
   counsel checkbox is unchecked for a path that no longer exists.
3. **DOC-003 (high)** — README omits RDP, VNC, and FTP connection types that ship enabled-by-default and
   are advertised in the CHANGELOG (README vs its own changelog).
4. **DOC-011 (high)** — README omits the shipped on-launch GitHub update-check (phones home every launch;
   no telemetry note) and the entire native plugin system (loads arbitrary native code via a C ABI) —
   with **no user-facing plugin trust warning**.
5. **DOC-010 (medium)** — remote-protocol.md presents two-sided version negotiation/"MUST reject
   incompatible major"; only the agent enforces it — the desktop sends a stale hardcoded `0.3.0` and
   validates nothing.

Runner-up contradictions: **DOC-007** (README Ctrl+W = Close Tab vs code/keyboard-shortcuts.md
Ctrl+Shift+W), **DOC-009** (README "Windows X11 not supported" vs shipped VcXsrv provisioning +
licensing docs), **DOC-008** (README example commands point to non-existent script paths).

## Release-critical missing docs

- **User-facing plugin trust warning + plugin feature doc** (DOC-011) — arbitrary native code loads
  from installed plugins with no README mention or warning.
- **User-facing note on the on-launch update-check / what data leaves the machine** (DOC-011) — the only
  "phones home" behavior, undocumented; relevant for isolated/air-gapped deployment decisions.
- **RDP/VNC/FTP in the README** (DOC-003) — shipped features a user cannot discover from the landing doc.
- **Licensing doc correctness** (DOC-002) — compliance/legal doc must be right and its checklist
  completable before release; today it references removed code and an open counsel gate.

## Severity counts

- critical: 0
- high: 4 (DOC-001, DOC-002, DOC-003, DOC-011)
- medium: 4 (DOC-004, DOC-007, DOC-009, DOC-010)
- low: 5 (DOC-005, DOC-006, DOC-008 [medium-leaning], DOC-012, DOC-013)

## Finding index

- DOC-001 — Projection module headers still say "Shadow / not driving the live UI" (high)
- DOC-002 — licensing.md VcXsrv redistribution contradiction + dead file ref + unchecked counsel gate (high, is_workaround)
- DOC-003 — README omits shipped RDP/VNC/FTP connection types (high)
- DOC-004 — docs/audits/*state-machine*.md stale, not marked historical (medium)
- DOC-005 — ">80% Rust coverage" target unmeasured (low)
- DOC-006 — CI `--reruns 2` comment vs actual `--reruns 4` (low)
- DOC-007 — README Close-Tab shortcut Ctrl+W wrong (should be Ctrl+Shift+W) (medium)
- DOC-008 — README example commands point to wrong script paths (medium)
- DOC-009 — README "Windows X11 not supported" contradicts shipped provisioning + licensing docs (medium)
- DOC-010 — Protocol version negotiation enforced only on agent, not desktop (spec implies both) (medium)
- DOC-011 — README omits update-check + native plugin system; no plugin trust warning (high)
- DOC-012 — CHANGELOG 0.1.0 uncurated; version-bump commits 3 of 4 files (low)
- DOC-013 — release-plan-0.1.0.md stale (retired tauri-driver E2E; superseded process) (low)
