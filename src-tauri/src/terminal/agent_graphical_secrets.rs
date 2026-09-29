//! Desktop-side secrets of VNC/RDP connections hosted under an agent (#3803).
//!
//! A VNC/RDP connection saved under an agent is stored on the agent host like
//! every other agent definition, but it is run by **this computer's** VNC/RDP
//! backend through a port forward over the agent (#3241). Its password is only
//! ever needed here, so it never belongs on the agent host:
//!
//! - **Save / update** — the `password` is removed from the definition before
//!   it is sent to the agent. When the definition opts into storing it
//!   (`savePassword`, the one save option of every connection type; the
//!   legacy `saveToStore` key is read as it, #3818) it is written to the
//!   desktop credential store under
//!   [`credential_key`]; otherwise it is only used for the connect that follows
//!   and prompted for next time.
//! - **Connect** — the frontend resolves the secret from the desktop store
//!   (same key, via `resolve_credential`) or prompts for it.
//! - **Delete** — the desktop copy is removed with the definition.
//! - **Migration** — a definition listed from the agent that still carries a
//!   password (saved before this change) has it moved into the desktop store
//!   and is rewritten on the agent without it. While the store is locked, or
//!   the write fails, the agent copy is kept (it is the only one) and the
//!   migration is retried on the next listing; with no store configured
//!   (`none` mode) passwords are never persisted, so the agent copy is dropped
//!   and the password is prompted for at connect time. In every case the
//!   definition handed back to the frontend no longer carries it.
//!
//! Secrets are never logged: only agent and definition ids are.

use serde_json::Value;
use termihub_core::connection::save_password::{normalize_save_password, SAVE_PASSWORD_KEY};
use termihub_core::protocol::methods::{ConnectionCreateParams, ConnectionUpdateParams};
use tracing::{debug, info, warn};
use zeroize::Zeroizing;

use crate::credential::{CredentialKey, CredentialStore, CredentialStoreStatus, CredentialType};
use crate::terminal::agent_manager::AgentDefinitionInfo;
use crate::utils::errors::TerminalError;

/// Prefix of every agent-tunnelled graphical credential owner id.
pub const OWNER_PREFIX: &str = "agent-graphical:";

/// Graphical types an agent carries by tunnelling (mirrors the frontend's
/// `AGENT_TUNNELLED_GRAPHICAL_TYPES`).
const TUNNELLED_GRAPHICAL_TYPES: [&str; 2] = ["vnc", "rdp"];

/// The settings key holding the VNC/RDP password.
const PASSWORD_KEY: &str = "password";

/// Whether `session_type` is a graphical type run here and tunnelled through
/// the agent.
pub fn is_tunnelled_graphical(session_type: &str) -> bool {
    TUNNELLED_GRAPHICAL_TYPES.contains(&session_type)
}

/// Credential owner id of definition `def_id` on agent `agent_id`.
pub fn owner_id(agent_id: &str, def_id: &str) -> String {
    format!("{OWNER_PREFIX}{agent_id}:{def_id}")
}

/// Credential-store key of the password of definition `def_id` on `agent_id`.
pub fn credential_key(agent_id: &str, def_id: &str) -> CredentialKey {
    CredentialKey::new(&owner_id(agent_id, def_id), CredentialType::Password)
}

/// Remove the password from `config`, returning it when it is non-empty.
fn take_secret(config: &mut Value) -> Option<Zeroizing<String>> {
    let removed = config.as_object_mut()?.remove(PASSWORD_KEY)?;
    match removed {
        Value::String(s) if !s.is_empty() => Some(Zeroizing::new(s)),
        Value::String(s) => {
            drop(Zeroizing::new(s));
            None
        }
        _ => None,
    }
}

/// Whether `config` opts into keeping its password in the credential store,
/// rewriting a legacy `saveToStore` flag to `savePassword` first (#3818).
fn wants_saved(config: &mut Value) -> bool {
    normalize_save_password(config);
    config.get(SAVE_PASSWORD_KEY).and_then(Value::as_bool) == Some(true)
}

/// Drop any password from a definition before it is handed to the frontend,
/// and show a legacy save flag as the unified one.
fn scrub(def: &mut AgentDefinitionInfo) {
    if is_tunnelled_graphical(&def.session_type) {
        drop(take_secret(&mut def.config));
        normalize_save_password(&mut def.config);
    }
}

/// Write an opted-in secret to the desktop store. A failure is logged, not
/// returned: the definition itself was saved, and the connect prompts.
fn store_secret(store: &dyn CredentialStore, agent_id: &str, def_id: &str, secret: &str) {
    match store.set(&credential_key(agent_id, def_id), secret) {
        Ok(()) => debug!(
            agent_id,
            definition_id = def_id,
            "Stored remote-desktop password in the desktop credential store"
        ),
        Err(e) => warn!(
            agent_id,
            definition_id = def_id,
            "Could not store remote-desktop password in the desktop credential store \
             (it will be prompted for at connect time): {e}"
        ),
    }
}

/// Create a definition on the agent via `save`, keeping a VNC/RDP password
/// out of the agent-side definition (see the module docs).
pub fn save_definition<F>(
    store: &dyn CredentialStore,
    agent_id: &str,
    mut params: ConnectionCreateParams,
    save: F,
) -> Result<AgentDefinitionInfo, TerminalError>
where
    F: FnOnce(ConnectionCreateParams) -> Result<AgentDefinitionInfo, TerminalError>,
{
    if !is_tunnelled_graphical(&params.session_type) {
        return save(params);
    }
    let secret = take_secret(&mut params.config);
    let keep = wants_saved(&mut params.config);
    let mut saved = save(params)?;
    if let (Some(secret), true) = (secret, keep) {
        store_secret(store, agent_id, &saved.id, &secret);
    }
    scrub(&mut saved);
    Ok(saved)
}

/// Update a definition on the agent via `update`, keeping a VNC/RDP password
/// out of the agent-side definition. An empty password leaves a stored one
/// in place (the editor shows the field empty when the secret is stored).
pub fn update_definition<F>(
    store: &dyn CredentialStore,
    agent_id: &str,
    mut params: ConnectionUpdateParams,
    update: F,
) -> Result<AgentDefinitionInfo, TerminalError>
where
    F: FnOnce(ConnectionUpdateParams) -> Result<AgentDefinitionInfo, TerminalError>,
{
    let graphical = params
        .session_type
        .as_deref()
        .is_some_and(is_tunnelled_graphical);
    let mut pending = None;
    if graphical {
        if let Some(config) = params.config.as_mut() {
            let secret = take_secret(config);
            if wants_saved(config) {
                pending = secret;
            }
        }
    }
    let def_id = params.id.clone();
    let mut updated = update(params)?;
    if let Some(secret) = pending {
        store_secret(store, agent_id, &def_id, &secret);
    }
    scrub(&mut updated);
    Ok(updated)
}

/// Remove the desktop copy of a deleted definition's password (best effort;
/// removing an absent key is a no-op).
pub fn forget_definition(store: &dyn CredentialStore, agent_id: &str, def_id: &str) {
    if let Err(e) = store.remove(&credential_key(agent_id, def_id)) {
        debug!(
            agent_id,
            definition_id = def_id,
            "Could not remove remote-desktop password of a deleted definition: {e}"
        );
    }
}

/// Move the password of every listed VNC/RDP definition that still carries
/// one into the desktop store and rewrite it on the agent without it, via
/// `update` (see the module docs). Returns the definitions, all scrubbed.
pub fn migrate_definitions<F>(
    store: &dyn CredentialStore,
    agent_id: &str,
    definitions: Vec<AgentDefinitionInfo>,
    mut update: F,
) -> Vec<AgentDefinitionInfo>
where
    F: FnMut(ConnectionUpdateParams) -> Result<AgentDefinitionInfo, TerminalError>,
{
    // These keys are only derivable from the agent's listing: remember their
    // names (no keychain read) so the on-demand seed before an export or store
    // switch probes them (#3434, #3844).
    let graphical_keys: Vec<CredentialKey> = definitions
        .iter()
        .filter(|def| is_tunnelled_graphical(&def.session_type))
        .map(|def| credential_key(agent_id, &def.id))
        .collect();
    if !graphical_keys.is_empty() {
        store.note_key_candidates(&graphical_keys);
    }
    definitions
        .into_iter()
        .map(|mut def| {
            if !is_tunnelled_graphical(&def.session_type) {
                return def;
            }
            // Show a legacy save flag as the unified one, whatever happens next.
            normalize_save_password(&mut def.config);
            let Some(secret) = take_secret(&mut def.config) else {
                return def;
            };
            let def_id = def.id.clone();
            let moved = match store.status() {
                CredentialStoreStatus::Unlocked => {
                    if let Err(e) = store.set(&credential_key(agent_id, &def_id), &secret) {
                        warn!(
                            agent_id,
                            definition_id = %def_id,
                            "Could not move the remote-desktop password of an agent \
                             definition into the desktop credential store; keeping it on \
                             the agent until the next attempt: {e}"
                        );
                        return def;
                    }
                    if let Some(obj) = def.config.as_object_mut() {
                        obj.insert(SAVE_PASSWORD_KEY.to_string(), Value::Bool(true));
                    }
                    true
                }
                CredentialStoreStatus::Locked => {
                    info!(
                        agent_id,
                        definition_id = %def_id,
                        "Agent definition still carries a remote-desktop password; it moves \
                         into the desktop credential store once the store is unlocked"
                    );
                    return def;
                }
                CredentialStoreStatus::Unavailable => {
                    warn!(
                        agent_id,
                        definition_id = %def_id,
                        "Removed the remote-desktop password from an agent definition; no \
                         credential store is configured, so it is prompted for at connect time"
                    );
                    false
                }
            };
            let params = ConnectionUpdateParams {
                id: def_id.clone(),
                name: None,
                session_type: None,
                config: Some(def.config.clone()),
                persistent: None,
                folder_id: None,
                terminal_options: None,
                icon: None,
            };
            match update(params) {
                Ok(mut rewritten) => {
                    if moved {
                        info!(
                        agent_id,
                        definition_id = %def_id,
                        "Moved the remote-desktop password of agent definition {def_id} out of \
                         the agent host's connection store into the desktop credential store"
                        );
                    }
                    scrub(&mut rewritten);
                    rewritten
                }
                Err(e) => {
                    warn!(
                        agent_id,
                        definition_id = %def_id,
                        "Could not rewrite agent definition without its remote-desktop \
                         password; retrying on the next listing: {e}"
                    );
                    def
                }
            }
        })
        .collect()
}

#[cfg(test)]
#[path = "agent_graphical_secrets_tests.rs"]
mod tests;
