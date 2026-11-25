//! Automations: the single user-facing type that merges macros and workflows
//! (#5818, concept `docs/concepts/partial/automations.html`).
//!
//! - `config` and `convert` (slice 1): the persisted model and the pure
//!   converters from the legacy macro and workflow shapes.
//! - `store`, `storage`, `manager` (slice 2): `automations.json` and its CRUD.
//! - `history`, `history_manager` (slice 2): `automation-runs.json`.
//! - `legacy`, `migrate`, `migrate_runs` (slice 2): the boot migration from
//!   the legacy files and the reconcile pass that merges back what an older
//!   build changed in them.
//!
//! The legacy macro and workflow stores keep serving the UI until the
//! frontend switches over (slice 4).

pub mod config;
pub mod convert;
pub mod history;
pub mod history_manager;
pub mod legacy;
pub mod manager;
pub mod migrate;
pub mod migrate_runs;
pub mod storage;
pub mod store;

#[cfg(test)]
mod config_tests;
#[cfg(test)]
mod convert_tests;
#[cfg(test)]
mod history_tests;
#[cfg(test)]
mod manager_tests;
#[cfg(test)]
mod migrate_tests;
#[cfg(test)]
mod unknown_fields_tests;
