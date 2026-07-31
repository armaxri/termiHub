//! Shadow app-settings authority — Phase 5 of the stateless-UI migration
//! (#2227, part of #2153 / #2139).
//!
//! Moves the app-settings slice the frontend drives in `appStore` (the
//! `AppSettings` document — `settings` / `savedSettings`, the persisted user
//! preferences behind `updateSettings` / `saveSettings`) into a Rust authority.
//! The store owns a single **shared** `settings` projection region (Open Design
//! Decision #4: `AppSettings` is a single persisted document every client sees)
//! and serves the `settings.*` intents through the projection substrate
//! ([`crate::projection`]), mirroring the shared system-monitor
//! ([`crate::system_monitor_projection`]) and agents
//! ([`crate::agents_projection`]) shadows.
//!
//! # The settings document is modeled opaquely
//!
//! `AppSettings` is one large, open-ended JSON document (~50 keys, forward-
//! compatible: older files omit keys, newer clients add them) that the app loads
//! and saves as a whole (`get_settings` / `save_settings`, persisted in
//! [`crate::connection::settings`]). The frontend `AppSettings` (`appStore`'s
//! authoritative shape) also carries presentation keys the backend's typed
//! struct does not mirror. So — like the backend already treats `customThemes` /
//! `syntaxHighlighting` as opaque `serde_json::Value` — this store models the
//! document as an **opaque JSON object**: it owns the whole-document replace and
//! shallow-patch semantics `appStore` drives without duplicating (and drifting
//! from) the 50-field typed struct. This is the coherent core the shadow needs;
//! per-key typing is neither required by the render/mutation cuts nor desirable.
//!
//! # Shared region — Open Design Decision #4 / #6
//!
//! `AppSettings` is a single persisted document: in a multi-client world every
//! client sees the same settings and an edit projects to all (like SSH tunnels,
//! [`crate::tunnel::projection`], and the shared session-lifecycle region,
//! [`crate::session_projection`]). The region is therefore a single **shared**
//! `settings` region. Any device-local preference that should *not* sync (were
//! one ever carved out) would become a client-scoped presentation region instead
//! — none exists today, so the whole `AppSettings` document is shared here.
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not** authoritative. The store exists, accepts
//! `settings.*` intents, and projects diffs, but nothing in the live UI
//! subscribes to or renders the `settings` region, and no frontend code
//! dispatches `settings.*` intents yet. The existing `appStore` `settings` slice
//! and its `updateSettings` / `saveSettings` persistence remain authoritative.
//! Later steps cut rendering, then mutation, over to the region, then remove the
//! `appStore` state.

pub mod projection;
pub mod store;

pub use store::SettingsStore;
