# Product / feature-completeness audit — termiHub

Angle 1: product / power-user expert. Scope: the whole app as experienced by a user —
UI surfaces (`src/components/*`), state (`src/store`), backend capabilities
(`core/src/backends`, `src-tauri/src/commands`), and docs/README. Method: mapped what the
UI exposes vs. what the backend supports vs. what's documented, feature area by feature area.

**68 findings** (PROD-001 … PROD-068). Overall the app is far more complete than a typical
pre-v0.1.0 codebase: SSH is rich (jump host, agent/X11 forwarding, resilient reconnect,
trust store), tunnels are feature-complete across all three directions with stats/reconnect/
agent hosting, the plugin system is a real native ABI loader with trust/capabilities, agents
and session-restore are essentially complete, themes/keyboard-shortcuts are customizable, and
VNC/RDP are genuine implementations (not stubs). The gaps are concentrated in **file
management depth**, **monitoring breadth**, **Docker's core use case**, **workflow logic**,
and **discoverability of finished-but-gated work**.

## Feature matrix (completeness by area)

| Area | Completeness | Notable gaps |
|---|---|---|
| SSH terminal | ● ● ● ● ○ | keepalive not configurable (024); tunnels not attachable in editor (023) |
| Local / WSL / serial | ● ● ● ● ○ | serial complete; no monitoring on local/WSL (022) |
| Telnet | ● ● ○ ○ ○ | host+port only; no auto-login/NAWS (025, 027) |
| Docker | ● ● ○ ○ ○ | **run-new-only, no exec into running container (016)**; no listing/compose (017) |
| FTP (as connection) | ● ● ● ○ ○ | first-class type; but rich transfer engine unwired (010) |
| RDP / VNC | ● ● ● ○ ○ | real, but experimental-gated + not in README (067); no multi-monitor (018), audio/res gaps (019–021,026) |
| SFTP / file browser | ● ● ○ ○ ○ | **no chmod (001)**, no chown/symlink (002,003), no dual-pane/bookmarks (007), no multi-download (005), no drag-move (006), no hidden toggle (008) |
| File transfers | ● ● ○ ○ ○ | **SFTP pause/resume dead (009)**, **FTP engine unwired (010)**, no persistence (011), SFTP no resume (012) |
| File editor | ● ● ● ○ ○ | solid, but **no large-file guard (014)** |
| Tunnels | ● ● ● ● ● | complete; cosmetic stats gaps (037, 038) |
| Embedded servers | ● ● ● ○ ○ | no access log (034), HTTP no auth (035) |
| Network tools | ● ● ● ○ ○ | no export (031), no history (032), 3 tools local-only (033) |
| System monitoring | ● ● ○ ○ ○ | **no process list/kill (028)**, SSH-only (022), no net/swap (029), no graphs (030) |
| Macros | ● ● ● ○ ○ | record-only (039), no params (040), no triggers (041), no broadcast (042) |
| Workflows | ● ● ○ ○ ○ | **linear only, no conditionals (044)**, no error handling (045), no run history (046), single target (047) |
| Plugins | ● ● ● ○ ○ | no marketplace (048), frontend extensions experimental-off (049), no OS sandbox (050) |
| Workspaces | ● ● ● ● ○ | no per-workspace settings (052), not in palette (053) |
| Command palette | ● ● ● ○ ○ | curated action subset only (054) |
| Keyboard shortcuts | ● ● ● ● ○ | no keymap import (055) |
| Terminal features | ● ● ● ● ○ | no hyperlinks (056), no image/sixel (057), search polish (058), no cmd-nav (059) |
| Split views | ● ● ● ● ○ | no max-pane guard (060) |
| Broadcast | ● ● ● ● ○ | no persistent named groups (061) |
| Themes | ● ● ● ● ○ | font not in theme (062) |
| Credential store | ● ● ● ○ ○ | no export/backup (063), no biometric (064), no cross-connection sharing (065) |
| Remote agents | ● ● ● ● ● | complete |
| Session restore / history | ● ● ● ● ● | complete |
| Backup / export | ● ● ○ ○ ○ | connections only; no unified backup (068) |

(● filled = degree of completeness, rough; 5 = complete.)

## Top 10 missing/incomplete features for v0.1.0 (ranked by user impact)

1. **PROD-016 — Docker can't exec into a running container** (high). The dominant Docker
   workflow is unsupported; only `docker run` a fresh container.
2. **PROD-010 — FTP's full transfer engine is unwired** (high, workaround). Progress/ETA/
   resume/retry all built, but FTP transfers use an in-memory whole-file byte path instead.
3. **PROD-009 — SFTP Pause/Resume/Retry buttons do nothing** (high, workaround). Dead
   controls that appear functional.
4. **PROD-014 — File editor has no large-file guard** (high, reliability). Opening a big file
   loads it fully into memory and can freeze/crash the app.
5. **PROD-044 — Workflows are linear-only (no conditionals/loops/wait-for-output)** (high).
   The flagship automation feature can't make decisions.
6. **PROD-028 — Monitoring has no process list / kill** (high). A monitor you can't act on.
7. **PROD-004 — Directory copy/paste to a remote is unsupported** (high). Pasting a folder to a
   remote outright fails; even single-file remote copy round-trips through the client.
8. **PROD-001 — No chmod in the SFTP browser** (high). Permissions shown but not editable.
9. **PROD-022 — Monitoring is SSH-only** (high). No local/Docker/WSL monitoring.
10. **PROD-067 — RDP/VNC are finished but experimental-gated and absent from the README**
    (medium, workaround). Major working capability is undiscoverable.

## Release-blocker candidates

These are the ones most likely to bite users or embarrass a release, and worth a maintainer
decision before v0.1.0:

- **PROD-009 / PROD-010 (workarounds)** — dead SFTP transfer controls and an unwired FTP
  transfer engine. Both are "finished work not connected"; low effort to fix, high embarrassment
  if shipped.
- **PROD-014** — large-file open with no guard is a crash-on-common-path reliability risk.
- **PROD-066 (workaround)** — the mock/test remote-desktop backend is registered in the default
  build; it should not ship as a user-selectable connection type.
- **PROD-016** — Docker's missing exec-into-running-container makes the advertised Docker type
  fall short of the near-universal expectation.
- **PROD-067** — decide RDP/VNC release status (un-gate + document, or clearly mark experimental
  in the README); today it's ambiguous.

Everything else is a genuine feature/parity gap but has either a workaround or limited blast
radius, and can be sequenced after the blockers.
