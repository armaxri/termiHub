//! Automations: the single user-facing type that merges macros and workflows
//! (#5818, concept `docs/concepts/partial/automations.html`).
//!
//! Slice 1 holds only the persisted model ([`config`]) and the pure
//! converters from the legacy macro and workflow shapes ([`convert`]). Storage,
//! IPC, the boot migration and the runner arrive in later slices; nothing here
//! is wired into the running app yet.

pub mod config;
pub mod convert;

#[cfg(test)]
mod config_tests;
#[cfg(test)]
mod convert_tests;
