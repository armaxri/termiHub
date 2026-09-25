//! `LayoutStore` — the authoritative panel-tree store of the stateless-UI
//! migration (#2151, part of #2139).
//!
//! Moves the panel-tree + minimal tab model into a Rust authority built on the
//! ported panel-tree algebra (`termihub_core::layout::panel_tree`, #2143). The
//! store owns a **client-scoped** `layout@<clientId>` projection region and
//! serves the `layout.*` intents (split / merge / move-tab / close-tab-
//! structure) through the projection substrate ([`crate::projection`]),
//! mirroring the SSH-tunnels pilot ([`crate::tunnel::projection`]).
//!
//! # Authority (#2283 / #2562)
//!
//! Like the other projection domains, layout has completed the stateless-UI
//! inversion: the `layout@<clientId>` region is the **sole writer** of the
//! panel-tree structure. The frontend no longer keeps `rootPanel`/`tabGroups`
//! reducers — it dispatches `layout.*` intents for granular structural
//! mutations, reseeds the region for writers without a granular intent, and
//! renders the tree composed from the region view (`src/store/layoutBridge.ts`).
//!
//! Because layout is per-window/per-client view arrangement, each attached
//! client gets its own `layout@<clientId>` region (Open Design Decision #1/#6:
//! multi-client is in scope), seeded and mutated by `intent.client_id`.

pub mod projection;
pub mod store;

pub use store::LayoutStore;
