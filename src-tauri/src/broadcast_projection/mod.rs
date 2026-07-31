//! Shadow broadcast-membership authority — Phase 4 step 5b of the stateless-UI
//! migration (#2242, part of #2206 / #2152 / #2139).
//!
//! Moves the broadcast-input **membership** state machine the frontend drives
//! (`appStore` `broadcastActive` / `broadcastSourceTabId` / `broadcastScope` /
//! `broadcastTargetTabIds` / `lastBroadcastScope`, #1955 / #1956 / #1958) into a
//! Rust authority on the projection substrate ([`crate::projection`]). Broadcast
//! input mirrors what the user types in one *source* terminal to a group of
//! *target* terminals; this module owns which tabs are in that group, the scope
//! the group was derived from, and the last scope remembered for the keyboard
//! toggle — the membership orchestration, not the input fan-out.
//!
//! Broadcast is the second of #2206's three machines; the restore-cohort machine
//! landed its shadow first ([`crate::restore_cohort_projection`], PR #2240), and
//! the workflow machine migrates as its own step.
//!
//! # Client-scoped region — Open Design Decision #4 / #6
//!
//! Unlike the shared `session-lifecycle` region (a session's status is a
//! property of the shared session), broadcast membership is a **per-client
//! input-fan-out overlay over that client's own tabs**: the target ids are tab
//! ids from a per-window tab tree, the source is the terminal focused in *this*
//! window, and two windows can each run an independent broadcast session. It is
//! a property of the viewing client, not of shared infrastructure — so the
//! region is **client-scoped** (`broadcast@<clientId>`), mirroring the
//! client-scoped `layout` ([`crate::layout::projection`]) and `restore-cohort`
//! ([`crate::restore_cohort_projection`]) regions.
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not authoritative**. The store exists, accepts
//! `broadcast.*` intents, and projects diffs, but nothing in the live UI
//! subscribes to or renders a `broadcast` region, and no frontend code
//! dispatches `broadcast.*` intents yet. The existing `appStore` broadcast
//! reducers remain authoritative. Later steps cut rendering, then the mutations,
//! over to it (keeping the reducers as the parity-safe fallback, per the #2205
//! reframe). The scope-to-tabs resolution, the connected-terminal fan-out
//! filter, and dynamic-membership recompute stay frontend — they need the live
//! tab tree the layout machine owns (see [`store`]).

pub mod projection;
pub mod store;

pub use store::BroadcastStore;
