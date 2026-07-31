//! Shadow workflow-run authority — Phase 4 step 5c of the stateless-UI
//! migration (#2243, part of #2206 / #2152 / #2139).
//!
//! Moves the in-flight **workflow-run** state machine the frontend drives
//! (`appStore` `workflowRun` + `workflowRunOutput`, #1852 / #1865) into a Rust
//! authority on the projection substrate ([`crate::projection`]). The run
//! machine tracks a single active run's step progress (`run`) and the
//! dismissible inline output panel a `run-local-process` step opens (`output`),
//! settling both through the run's terminal outcome (completed / cancelled /
//! failed).
//!
//! This is the **run** machine, not the workflow **library**: the library CRUD
//! is already backend-backed (`workflowApi`). The step-execution side-effects
//! (the send / macro / local-process seams in `workflowRunner`) stay frontend
//! orchestration; this store owns only the run *status* — which run is active,
//! how far it has progressed, and the status of its output panel.
//!
//! # Client-scoped region — Open Design Decision #4 / #6
//!
//! A workflow run is launched by one client against one of *that client's*
//! target terminals, and its feedback — the progress toast and the inline
//! run-output panel — is the launching client's own UI overlay. Only one run is
//! active per client at a time (`appStore` cancels any in-flight run before
//! starting another). Like the client-scoped `restore-cohort`
//! ([`crate::restore_cohort_projection`]) and `broadcast`
//! ([`crate::broadcast_projection`]) regions — and unlike the shared
//! `session-lifecycle` region — the run is an **orchestration overlay owned by
//! the launching client, not shared infrastructure**. So the region is
//! **client-scoped** (`workflow-run@<clientId>`), mirroring the client-scoped
//! `layout` region ([`crate::layout::projection`]).
//!
//! (The terminal *session* the run targets is shared, but the *run
//! orchestration over it* — progress, cancel, output panel — belongs to the one
//! client that launched it. A second client viewing the same terminal does not
//! see or drive this client's run.)
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not authoritative**. The store exists, accepts
//! `workflow.*` intents, and projects diffs, but nothing in the live UI
//! subscribes to or renders a `workflow-run` region, and no frontend code
//! dispatches `workflow.*` intents yet. The existing `appStore` run reducers,
//! the progress toast, and the output panel remain authoritative. Later steps
//! cut rendering, then the mutations, over to it (keeping the reducers as the
//! parity-safe fallback, per the #2205 reframe); the sibling restore-cohort and
//! broadcast machines migrated as their own steps and keep a clean per-domain
//! boundary.

pub mod projection;
pub mod store;

pub use store::WorkflowRunStore;
