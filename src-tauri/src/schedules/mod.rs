//! Scheduled workflows and macros (PROD-043).
//!
//! A [`config::Schedule`] runs a stored workflow (or macro) against an explicit
//! set of targets — saved connection ids or a named broadcast group, never
//! "whatever tab is active" — on a time-based rule: every N minutes, daily at a
//! local time, or on chosen weekdays at a local time.
//!
//! The **backend owns the clock**: [`manager::ScheduleManager`] decides when a
//! schedule is due (DST-aware, see [`timing`]), enforces the safety rules (no
//! overlapping runs, global pause, missed-run policy, disabled until confirmed)
//! and persists the schedules plus their last result. The loop in [`runner`]
//! ticks it and, when a schedule fires, emits a `schedule-fire` event to every
//! app window. The frontend — which owns the tabs and the workflow runner —
//! runs the workflow on the matching *connected* terminals of its window
//! (unattended: it never prompts) and reports back with
//! `report_schedule_run`, which settles the run. Only a schedule that opts into
//! "Connect if not connected" (#3527) connects its missing targets first — in
//! one designated window, unattended (stored credentials, trusted host keys,
//! never a prompt) — and closes the tabs it opened when the run ends.
//!
//! Scheduling only happens while the app runs; there is no OS service.

pub mod config;
pub mod history;
pub mod manager;
pub mod runner;
pub mod storage;
mod tick;
pub mod timing;
pub mod wire;
