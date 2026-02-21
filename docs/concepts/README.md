# Concept Documents — Status Overview

Concept documents in this directory are **open** — not yet implemented or only partially done. Fully implemented concepts (or those with active implementation tickets) live in [`handled/`](handled/).

## Open Concepts

### cross-platform-testing.md (Issue #15)

**Status: Not implemented**

None of the proposed artifacts exist: no platform-specific test modules (`platform_tests.rs`), no Windows E2E CI job, no release verification issue template, no `XPLAT-*` test identifiers, no `needs-platform-testing` labels. The CI runs the same test suite across a 3-platform matrix (`ubuntu`, `windows`, `macos`) but without the explicit platform-divergent testing the concept proposes. No follow-up implementation issues were created.

### light-color-theme.md (Issue #193)

**Status: Partially implemented**

The core theme engine is done (PR #223): `ThemeEngine` with Dark/Light/System themes, CSS variable refactoring, xterm.js live re-theming, and an Appearance settings panel. However, the custom theme portion was explicitly deferred ("Custom theme editor deferred to a future PR") and never built. Missing: `ThemeEditor` component, `customThemes` field on `AppSettings`, theme import/export, user-defined custom themes. No follow-up issue exists for the remaining work.

### plugin-system.md (Issue #28)

**Status: Not implemented**

No code, types, or infrastructure exist anywhere in the codebase. No `PluginManager`, `PluginRegistry`, or `PluginManifest` types in Rust; no `src/types/plugin.ts`; no `src/components/Plugins/` directory; no `libloading` dependency for dynamic Rust libraries; no `window.termihub` frontend plugin API; no `.termihub-plugin` package format. This is the most ambitious concept (7 planned PRs spanning dynamic library loading, JS plugin API, plugin manager UI, etc.) and no follow-up implementation issues were created.

## Handled Concepts

The following have been moved to [`handled/`](handled/) because they are fully implemented or have active implementation tickets:

| Concept | Issue | Reason |
|---------|-------|--------|
| agent.md | — | Remote agent fully implemented in `agent/` crate |
| credential-encryption.md | #25 | Active implementation tickets: #249, #253, #255, #258, #259, #262, #263 |
| customize-layout.md | #196 | Fully implemented; all tickets (#238, #241, #242, #243) closed |
| nicer-settings.md | #191 | Fully implemented; two-panel layout, 4 categories, search, auto-save all present |
| ssh-key-passphrase.md | #121 | Active implementation tickets: #249, #255, #258, #259 |
| ssh-tunneling.md | #107 | Fully implemented in PR #225; all 3 forwarding types, full UI, session pooling |
