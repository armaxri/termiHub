//! Workflow-run authority — Phase 4 step 5c of the stateless-UI
//! migration (#2243, part of #2206 / #2152 / #2139).
//!
//! Moves the in-flight **workflow-run** state machine the frontend drives
//! (`appStore` `workflowRun` + `workflowRunOutput`, #1852 / #1865) into a Rust
//! authority on the projection substrate ([`crate::projection`]). The run
//! machine tracks the in-flight runs' step progress (`runs`, keyed by `runId`
//! since #3418 — several may run concurrently; `run` is the back-compat
//! most-recent one) and the
//! dismissible inline output panel a `run-local-process` step opens (`output`),
//! settling both through the run's terminal outcome (completed / cancelled /
//! failed).
//!
//! This is the **run** machine, not the workflow **library**: the library CRUD
//! is already backend-backed (`workflowApi`). The step-execution side-effects
//! (the send / macro / local-process seams in `workflowRunner`) stay frontend
//! orchestration; this store owns only the run *status* — which runs are active,
//! how far it has progressed, and the status of its output panel.
//!
//! # Client-scoped region — Open Design Decision #4 / #6
//!
//! A workflow run is launched by one client against one of *that client's*
//! target terminals, and its feedback — the progress toast and the inline
//! run-output panel — is the launching client's own UI overlay. A client may have
//! several runs in flight at once (a concurrent "Run on…" fan-out, #3418). Like the client-scoped `restore-cohort`
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
//! # Authoritative — drives the live UI (#2243)
//!
//! The stateless-UI inversion is complete (#2283): this store is authoritative.
//! The Workflow Manager's running badge + output-panel status render from the
//! projected `workflow-run@<clientId>` region, and the run transitions dispatch
//! the `workflow.*` intents below. The former `appStore` run reducers and the
//! render/mutation-cut flags were removed; `appStore` holds no workflow-run slice
//! and the intents are the sole write path. The transient progress toast stays a
//! frontend side-effect notification. The step side-effects and streamed output
//! stay frontend (see below); the sibling restore-cohort and broadcast machines
//! migrated as their own steps and keep a clean per-domain boundary.

pub mod projection;
pub mod store;

pub use store::WorkflowRunStore;
