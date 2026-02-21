# Concept Documents — Status Overview

Concept documents in this directory are **open** — not yet implemented or only partially done. Fully implemented concepts (or those with active implementation tickets) live in [`handled/`](handled/).

## Open Concepts

### cross-platform-testing.md (Issue #15)

Not implemented.
None of the proposed artifacts exist: no platform-specific test modules (`platform_tests.rs`), no Windows E2E CI job, no release verification issue template, no `XPLAT-*` test identifiers, no `needs-platform-testing` labels. The CI runs the same test suite across a 3-platform matrix (`ubuntu`, `windows`, `macos`) but without the explicit platform-divergent testing the concept proposes. No follow-up implementation issues were created.

### light-color-theme.md (Issue #193)

Partially implemented.
The core theme engine is done (PR #223): `ThemeEngine` with Dark/Light/System themes, CSS variable refactoring, xterm.js live re-theming, and an Appearance settings panel. However, the custom theme portion was explicitly deferred ("Custom theme editor deferred to a future PR") and never built. Missing: `ThemeEditor` component, `customThemes` field on `AppSettings`, theme import/export, user-defined custom themes. No follow-up issue exists for the remaining work.

### plugin-system.md (Issue #28)

Not implemented.
No code, types, or infrastructure exist anywhere in the codebase. No `PluginManager`, `PluginRegistry`, or `PluginManifest` types in Rust; no `src/types/plugin.ts`; no `src/components/Plugins/` directory; no `libloading` dependency for dynamic Rust libraries; no `window.termihub` frontend plugin API; no `.termihub-plugin` package format. This is the most ambitious concept (7 planned PRs spanning dynamic library loading, JS plugin API, plugin manager UI, etc.) and no follow-up implementation issues were created.

## Handled Concepts

The following have been moved to [`handled/`](handled/) because they are fully implemented or have active implementation tickets.

### agent.md

Fully implemented.
The remote agent is fully implemented in the `agent/` crate. It includes the JSON-RPC protocol, session daemon with binary frame protocol, shell/Docker/SSH/serial backends, file browsing (local, SFTP relay, Docker), system monitoring, and state persistence. No specific concept issue was filed — the concept document predates the issue tracker workflow.

### credential-encryption.md (Issue #25)

Active implementation tickets.
The concept is closed and has spawned multiple implementation tickets that are currently open: #249 (replace `strip_ssh_password` with `prepare_for_storage` using `CredentialStore`), #253 (frontend credential store API, events, and Zustand state), #255 (add "Save password/passphrase" checkbox to Connection Editor), #258 (integrate credential store into connection/reconnection flow), #259 (plaintext credential migration wizard), #262 (route external connection file credentials through `CredentialStore`), #263 (auto-lock timeout for Master Password credential store).

### customize-layout.md (Issue #196)

Fully implemented.
All implementation tickets are closed: #238 (layout state and actions in Zustand store), #241 ("Customize Layout..." menu entry in Activity Bar), #242 (`CustomizeLayoutDialog` component with presets and controls), #243 (`LayoutPreview` component). The full customize-layout feature is live, including the dialog, layout presets, and live preview.

### nicer-settings.md (Issue #191)

Fully implemented.
All five PRs described in the concept's migration path have been completed. The two-panel layout with category sidebar (`SettingsNav`), search bar (`SettingsSearch`), debounced auto-save, responsive compact mode, and version footer are all present. All four categories exist: General (`GeneralSettings`), Appearance (`AppearanceSettings`), Terminal (`TerminalSettings`), and External Files (`ExternalFilesSettings`). The `SettingsNav` was further extended to be generic and reusable (PR #216 applied it to the connection editor too). Related implementation tickets: #201 (default user/SSH key settings, closed), #199 (optional advanced settings, closed). #254 (Security settings panel) extends beyond the original concept scope.

### ssh-key-passphrase.md (Issue #121)

Active implementation tickets.
The concept is closed and shares several implementation tickets with the credential-encryption concept: #249 (replace `strip_ssh_password` with `prepare_for_storage`), #255 (add "Save password/passphrase" checkbox to Connection Editor), #258 (integrate credential store into connection/reconnection flow), #259 (plaintext credential migration wizard). The passphrase handling is tightly coupled with the credential encryption work.

### ssh-tunneling.md (Issue #107)

Fully implemented.
The entire concept was delivered in PR #225. Backend: all three forwarding types are implemented (`local_forward.rs`, `remote_forward.rs`, `dynamic_forward.rs` with SOCKS5 proxy), plus SSH session pooling (`session_pool.rs`), tunnel manager with CRUD/start/stop/auto-start/status tracking, and `tunnels.json` persistence. Frontend: `TunnelSidebar` with status indicators and actions, `TunnelEditor` with SSH connection dropdown, `TunnelDiagram` with the visual three-box diagram, activity bar integration with `ArrowLeftRight` icon, Zustand store actions, and live status/stats via Tauri events. Auto-start on launch and graceful shutdown on window close are both implemented.
