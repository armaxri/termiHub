pub mod config;
pub(crate) mod credential_migration;
pub mod credential_scope;
pub mod id_changes;
pub mod jump_host_resolver;
pub mod manager;
mod placement;
pub mod plugin_type_ids;
#[cfg(test)]
pub(crate) mod recording_credential_store;
pub mod recovery;
pub mod settings;
pub mod shell_integration;
pub mod storage;
pub mod tree;
