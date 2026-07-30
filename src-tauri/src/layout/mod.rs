//! Shadow `LayoutStore` — Phase 3 step 1 of the stateless-UI migration (#2151,
//! part of #2139).
//!
//! Moves the panel-tree + minimal tab model into a Rust authority built on the
//! ported panel-tree algebra (`termihub_core::layout::panel_tree`, #2143). The
//! store owns a **client-scoped** `layout@<clientId>` projection region and
//! serves the `layout.*` intents (split / merge / move-tab / close-tab-
//! structure) through the projection substrate ([`crate::projection`]),
//! mirroring the SSH-tunnels pilot ([`crate::tunnel::projection`]).
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not authoritative**. The store exists, accepts
//! intents, and projects diffs, but nothing in the live UI subscribes to or
//! renders the `layout@<clientId>` region, and no frontend code dispatches
//! `layout.*` intents yet. The existing `appStore` panel-tree reducers and
//! `SplitView` rendering are untouched. Later steps (2–5) cut structural
//! mutations over, then rendering, then remove the `appStore` reducers, then
//! add multi-window / restore.
//!
//! Because layout is per-window/per-client view arrangement, each attached
//! client gets its own `layout@<clientId>` region (Open Design Decision #1/#6:
//! multi-client is in scope), seeded and mutated by `intent.client_id`.

pub mod projection;
pub mod store;

pub use store::LayoutStore;
