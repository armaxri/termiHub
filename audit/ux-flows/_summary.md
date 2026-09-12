# UX flows audit — termiHub

Angle 3: UX expert. Scope: the end-to-end user experience as expressed in `src/components/**`,
`src/store`, `src/hooks`, and docs. Method: walked each key journey by reading the components and
their handlers through to the backend (dead-control claims are verified end-to-end, not assumed),
mapping friction, feedback gaps, missing guards, and IA problems. No builds, no git — read-only.

**34 findings (UX-001 … UX-034).** The app is far more polished than a typical pre-v0.1.0
codebase in its *recovery* surfaces — the connect overlay, disconnect/reconnect flow, credential-
store unlock/recovery, session-restore dialog, host-key MITM warning, and file-editor
save/conflict handling are all genuinely well designed. The UX weaknesses cluster in three
places: **onboarding/first-run is essentially absent**, **feedback is inconsistent and sometimes
outright misleading** (a "success" toast for an operation that did nothing), and **several
destructive actions lack the guards their siblings already have**.

## Counts by severity

| Severity | Count |
| --- | --- |
| critical | 0 |
| high | 6 |
| medium | 16 |
| low | 12 |
| **total** | **34** |

6 are `is_workaround: true` (UX-005, UX-016, UX-024, UX-025, UX-033; UX-016 also a bug).

## Key journeys — friction rating

Rating: ●●●●● excellent · ●●●○○ usable-with-friction · ●○○○○ broken/blocking.

| Journey | Rating | Headline friction |
| --- | --- | --- |
| **First run / onboarding** | ●○○○○ | No welcome/help/tour; Connections panel is blank with no CTA (UX-001); major features hidden behind a flag (UX-002); empty-window CTA dead-ends (UX-003); seed data unwired (UX-005) |
| **Create a connection** | ●●○○○ | One big form, all advanced fields expanded (UX-008); Cancel discards edits (UX-006); no Test Connection (UX-007); field help hidden (UX-009) |
| **Connect** | ●●●○○ | Excellent connect/disconnect/reconnect overlays; but silent pre-connect gap (UX-011), color-only tab status (UX-014), no explicit disconnect (UX-015) |
| **Browse / transfer files** | ●●○○○ | **Pause/Resume/Retry lie — success toast on a no-op (UX-016)**; silent downloads on local/Docker/FTP (UX-017); no large-file guard (UX-018); no ETA (UX-019) |
| **Set up a tunnel** | ●●●○○ | Strong error-recovery surface; Stop/Reconnect unguarded (UX-021), Save gives no toast (UX-022), optimistic "Started" (UX-023) |
| **Add / manage an agent** | ●●○○○ | Two-stage flow with good banners; but no-op self-update toggle (UX-024) and inert "Deferred" strategy with contradictory docs (UX-025) |
| **Save / restore a workspace** | ●●○○○ | **Launch destroys live sessions with no confirm (UX-026)**; duplicate names allowed (UX-027). Restore-on-startup dialog is a highlight. |
| **Discover features (palette/IA)** | ●●○○○ | Palette is a curated subset with missing siblings & surfaces (UX-028); Settings "General" overloaded (UX-029); shortcuts overlay is a read-only dead end (UX-031) |
| **Manage / kill open connections** | ●●○○○ | Good bulk-confirm pattern, but ~11 kill/disconnect actions swallow errors silently (UX-033) |
| **Error recovery (drops/auth/host-key)** | ●●●●○ | The strongest area — recoverable overlays, actionable messages, preserved scrollback, MITM warning |

## Top UX problems (ranked)

1. **UX-016 — Transfer Pause/Resume/Retry are lying controls.** On the common SSH/SFTP path the
   backend no-ops these (they only touch "rich"/FTP transfers) yet the UI *always* toasts success.
   The user sees "Transfer paused" while the transfer keeps running. A dead control is bad; a
   control that confirms a fake success is worse. (high, workaround/bug)
2. **UX-026 — Launching a workspace tears down all live sessions with no confirmation.** One click
   or Enter destroys every open session and swaps the layout. Delete is guarded; the more
   destructive Launch is not. Potential loss of in-progress work on a common action. (high)
3. **UX-033 — ~45 async actions swallow errors, including kill/disconnect in the Open Connections
   panel.** Teardown actions can fail silently while the UI optimistically removes the row — the
   user believes a connection is dead when it is still live. Systemic feedback gap. (high)
4. **UX-001 / UX-002 / UX-004 — Onboarding is absent.** First launch lands on a blank Connections
   panel with no empty state or CTA (UX-001); Tunnels/Services/Network Tools/Workflows are hidden
   behind an experimental flag with no signpost (UX-002); there is no in-app help/getting-started
   anywhere (UX-004). Time-to-first-connection depends on the user guessing. (high ×2 + medium)
5. **UX-018 — File editor has no large-file guard.** Opening a big remote file reads it whole into
   memory + Monaco with no warning or cancel — a likely freeze/crash, re-triggered on every
   external change. (high, reliability)

## Release-readiness read

**Not yet.** The recovery-path UX is release-grade, but three classes of problem are release-
relevant on the "ventilator-grade / no-workarounds" bar and should block or gate v0.1.0:

- **Misleading feedback** — UX-016 (fake success on a no-op) and UX-033 (silent teardown failures)
  actively mislead the user about system state. On a tool whose job is to manage connections
  safely, "we told you it worked and it didn't" is the most damaging failure mode.
- **Unguarded destructive actions** — UX-026 (workspace launch) and UX-021 (tunnel stop/reconnect)
  destroy live work/connections on a single mis-hit while their siblings (Delete) prompt.
- **Absent onboarding** — UX-001/002/004 mean a new user can install the app and not find their
  way to a first connection or to half the feature set.

The connect/edit friction (UX-006 through UX-015) and IA/discoverability items (UX-028 through
UX-032) are quality-of-life polish that can follow, but the misleading-feedback and destructive-
action findings are the ones that undermine trust and should be fixed before release. None is a
crash-on-launch, so the path to release-ready is well-defined: honest feedback (no success toast
without a real state change), a confirm on live-session teardown, and a minimal first-run empty
state + help entry.

## Well-executed surfaces (do not regress these)

Connect overlay with elapsed/timeout/abort/contextual fix hints
(`TerminalConnectionOverlay.tsx`); disconnect/reconnect recovery with preserved scrollback
(`TerminalDisconnectOverlay.tsx`); session-restore dialog with per-tab opt-in + unreachable
warnings (`SessionRestoreDialog.tsx`); credential-store unlock/recovery (`UnlockDialog.tsx`);
host-key MITM warning (`SshHostKeyPrompt.tsx`); file-editor save/unsaved/conflict handling
(`FileEditor.tsx`); tunnel error-recovery affordances (`TunnelListItem.tsx`); the
single-terminal-toast transfer contract (`transferFeedback.ts`); macro playback guards; inline
zod validation with focus-first-error in the connection editor.

## Finding index

| ID | Sev | Journey | Title |
| --- | --- | --- | --- |
| UX-001 | high | onboarding | Connections panel has no first-run empty state or CTA |
| UX-002 | high | onboarding | Tunnels/Services/Network Tools/Workflows hidden behind experimental flag |
| UX-003 | medium | onboarding | Empty-window CTA dead-ends; power-user copy shown to new users |
| UX-004 | medium | onboarding | No in-app help / getting-started / welcome surface |
| UX-005 | low | onboarding | Sample/seed connection data exists but is never wired in |
| UX-006 | medium | create | Cancel button discards unsaved connection edits without the dirty guard |
| UX-007 | medium | create | No "Test Connection" — must Save & Connect to validate |
| UX-008 | medium | create | SSH form shows all advanced fields expanded; no progressive disclosure |
| UX-009 | medium | create | Field help_text only renders for boolean fields |
| UX-010 | medium | connect | SSH key-passphrase prompt mislabeled "SSH Password" |
| UX-011 | medium | connect | Sidebar connect shows no feedback during resolve + pre-connect |
| UX-012 | low | connect | Sidebar connect password-cancel gives no feedback |
| UX-013 | low | connect | Stored credential silently discarded on auth failure |
| UX-014 | medium | connect | Tab connection status is a color-only dot, tooltip-gated |
| UX-015 | low | connect | No explicit disconnect action — must close the tab |
| UX-016 | high | transfers | Pause/Resume/Retry no-op for SSH/SFTP yet toast success (lying controls) |
| UX-017 | medium | files | Download from local/Docker/FTP/agent succeeds or fails silently |
| UX-018 | high | files | File editor has no large-file guard — can freeze the app |
| UX-019 | low | transfers | Transfer rows show no ETA / time-remaining |
| UX-020 | low | transfers | Two parallel transfer UIs with different controls |
| UX-021 | medium | tunnels | Tunnel Stop / force-Reconnect on a live tunnel have no confirmation |
| UX-022 | low | tunnels | Saving a tunnel gives no success toast; silent "Untitled Tunnel" |
| UX-023 | low | tunnels | "Save & Start" reports "Started" before the tunnel connects |
| UX-024 | medium | agents | "Allow agent self-update" toggle is a no-op |
| UX-025 | medium | agents | Agent "Deferred" update strategy is inert; three docs disagree |
| UX-026 | high | workspaces | Launching a workspace destroys all live sessions with no confirm |
| UX-027 | medium | workspaces | Save Workspace allows duplicate names, no overwrite prompt |
| UX-028 | medium | discoverability | Command palette is a curated subset — commands & surfaces unreachable |
| UX-029 | medium | IA | Settings "General" category overloaded across unrelated domains |
| UX-030 | low | IA | Confusing "confirm close…" setting labels |
| UX-031 | medium | discoverability | Shortcuts overlay is read-only with no link to the editor |
| UX-032 | medium | discoverability | Shortcut editor cannot record chord bindings |
| UX-033 | high | cross-cutting | ~45 async actions swallow errors → silent failures |
| UX-034 | low | connect | Host-key fingerprint not copyable; no old-vs-new comparison |
