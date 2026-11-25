//! The workflow files of older builds (`workflows.json`, `runs.json`), read by
//! the automations migration, its reconcile pass and the restore of an old
//! backup (#5818). Never written. The step vocabulary automations share
//! (conditions, loops, retries, parameters) lives here too.

pub mod config;
pub mod history;
