//! Shadow restore-cohort authority — Phase 4 step 5 of the stateless-UI
//! migration (#2206, part of #2152 / #2139).
//!
//! Moves the startup **restore-cohort** state machine the frontend drives
//! (`appStore` `restoreCohort` + `failedRestoreTabIds`, #1146 / #1227) into a
//! Rust authority on the projection substrate ([`crate::projection`]). The
//! cohort aggregates the fan-out feedback of a single restore/launch: it tracks
//! the set of tab ids one restore placed, settles them as each tab connects or
//! fails, and — when the last settles — produces one summary (the aggregate
//! toast the UI raises) plus the failed-tab set that drives the bulk "Reconnect
//! failed tabs" control (#1227).
//!
//! The closely-related **restore *decision*** logic (which tabs to restore, how
//! to prune a stored session) is already ported to `termihub_core::restore_mode`
//! (#2145) and served as query commands (#2200); this module is the stateful
//! *cohort orchestration* that sits on top of it.
//!
//! # Client-scoped region — Open Design Decision #4 / #6
//!
//! Unlike the shared `session-lifecycle` region (a session's status is a
//! property of the shared session), a restore cohort is an **orchestration
//! overlay + aggregate feedback owned by the client that launched the restore**:
//! each window restores its own layout and raises its own summary toast, and the
//! failed-tab retry is that client's action over that client's tabs. It is a
//! property of the viewing client, not of shared infrastructure — so the region
//! is **client-scoped** (`restore-cohort@<clientId>`), mirroring the
//! client-scoped `layout` region ([`crate::layout::projection`]).
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not authoritative**. The store exists, accepts
//! `restore.*` intents, and projects diffs, but nothing in the live UI
//! subscribes to or renders a `restore-cohort` region, and no frontend code
//! dispatches `restore.*` intents yet. The existing `appStore` cohort reducers
//! and the toast feedback remain authoritative. Later steps cut rendering, then
//! the mutations, over to it (keeping the reducers as the parity-safe fallback,
//! per the #2205 reframe); the sibling broadcast and workflow machines migrate
//! as their own steps and keep a clean per-domain boundary.

pub mod projection;
pub mod store;

pub use store::RestoreCohortStore;
