//! Agents projection: the shared `agents` region and the `agent.*` intents
//! (#2226, part of #2139).
//!
//! Exposes the authoritative [`AgentsStore`] as one versioned, multi-subscriber
//! projection region and turns the agent transitions the frontend currently
//! drives into [`Intent`]s — mirroring the SSH-tunnels pilot
//! ([`crate::tunnel::projection`]) and the system-monitor shadow
//! ([`crate::system_monitor_projection::projection`]).
//!
//! # The `agents` region
//!
//! **Shared** (Open Design Decision #4: infrastructure domains are shared). An
//! agent's connection/session status is a property of the agent, not of a viewing
//! client; agent definitions and folders are shared, persisted config. The view
//! model:
//!
//! ```json
//! {
//!   "agents": [ AgentEntry, … ],
//!   "sessions": { "<agentId>": [ AgentSession ] },
//!   "definitions": { "<agentId>": [ AgentDefinition ] },
//!   "folders": { "<agentId>": [ AgentFolder ] }
//! }
//! ```
//!
//! # Intents
//!
//! | kind                      | payload                                   | effect                               |
//! | ------------------------- | ----------------------------------------- | ------------------------------------ |
//! | `agent.add`               | `{ id, name, config?, agentSettings? }`   | append a fresh disconnected agent    |
//! | `agent.update`            | `{ id, name, config?, agentSettings? }`   | update persisted fields              |
//! | `agent.applySettings`     | `{ id, agentSettings }`                    | update just the settings             |
//! | `agent.remove`            | `{ id }`                                    | drop the agent + its sub-state       |
//! | `agent.reorder`           | `{ oldIndex, newIndex }`                    | move the agent in the list           |
//! | `agent.toggleExpanded`    | `{ id }`                                    | flip sidebar expansion               |
//! | `agent.status`            | `{ id, state, error? }`                     | set connection state (single writer) |
//! | `agent.setCapabilities`   | `{ id, capabilities }`                      | record negotiated capabilities       |
//! | `agent.disconnect`        | `{ id }`                                     | force disconnected + clear live      |
//! | `agent.refresh`           | `{ id, sessions, definitions, folders }`    | replace live/saved sub-state         |
//! | `agent.clearSessions`     | `{ id }`                                     | empty the live-session list          |
//! | `agent.saveDefinition`    | `{ id, definition }`                        | upsert a saved definition            |
//! | `agent.updateDefinition`  | `{ id, definition }`                        | replace a definition by id           |
//! | `agent.deleteDefinition`  | `{ id, definitionId }`                       | remove a definition                  |
//! | `agent.createFolder`      | `{ id, folder }`                             | append a folder                      |
//! | `agent.updateFolder`      | `{ id, folder }`                             | replace a folder by id               |
//! | `agent.deleteFolder`      | `{ id, folderId }`                           | remove a folder + reparent defs      |
//!
//! # Shadow mode
//!
//! Registered and fully served, but **not** driving the live UI: no frontend
//! subscribes to `agents` or dispatches `agent.*` yet, so these intents mutate
//! only the shadow store and project to a region nobody renders. The `appStore`
//! agents slice remains authoritative. Per the substrate contract the result of
//! an intent is never returned inline — it always arrives as a projection diff on
//! the `agents` region.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::agents_projection::store::{
    AgentConnectionState, AgentDefinition, AgentFolder, AgentsStore,
};
use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};

/// The projection region id for the agents domain (shared, per Open Design
/// Decision #4).
pub const AGENTS_REGION: &str = "agents";

/// Publish the `agents` region from the store, fanning a diff out to every
/// subscriber and returning the advanced region for the intent ack (empty when
/// the view did not change).
pub fn publish_agents(projector: &Projector, store: &AgentsStore) -> Vec<ProducedRegion> {
    match projector.publish(AGENTS_REGION, store.snapshot()) {
        Some(version) => vec![ProducedRegion {
            region: AGENTS_REGION.to_string(),
            version,
        }],
        None => Vec::new(),
    }
}

/// Register the `agent.*` intents on a handler registry.
///
/// Each route resolves the managed [`AgentsStore`] lazily (so it rejects
/// gracefully rather than panicking if the store is somehow absent), applies the
/// transition, and publishes the shared region. All transitions are pure/fast
/// in-memory edits, so they run inline on the dispatcher's single writer.
pub fn register_agent_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("agent.add", move |intent, projector| {
        let store = store_of(&handle)?;
        store.add(
            &required_str(intent, "id")?,
            &required_str(intent, "name")?,
            optional_value(intent, "config"),
            optional_value(intent, "agentSettings"),
        );
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.update", move |intent, projector| {
        let store = store_of(&handle)?;
        store.update(
            &required_str(intent, "id")?,
            &required_str(intent, "name")?,
            optional_value(intent, "config"),
            optional_value(intent, "agentSettings"),
        );
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.applySettings", move |intent, projector| {
        let store = store_of(&handle)?;
        let settings = intent
            .payload
            .get("agentSettings")
            .cloned()
            .ok_or_else(|| bad_payload("missing 'agentSettings'"))?;
        store.apply_settings(&required_str(intent, "id")?, settings);
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.remove", move |intent, projector| {
        let store = store_of(&handle)?;
        store.remove(&required_str(intent, "id")?);
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.reorder", move |intent, projector| {
        let store = store_of(&handle)?;
        store.reorder(
            required_usize(intent, "oldIndex")?,
            required_usize(intent, "newIndex")?,
        );
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.toggleExpanded", move |intent, projector| {
        let store = store_of(&handle)?;
        store.toggle_expanded(&required_str(intent, "id")?);
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.status", move |intent, projector| {
        let store = store_of(&handle)?;
        store.set_status(
            &required_str(intent, "id")?,
            required_state(intent)?,
            optional_str(intent, "error"),
        );
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.setCapabilities", move |intent, projector| {
        let store = store_of(&handle)?;
        let capabilities = intent
            .payload
            .get("capabilities")
            .cloned()
            .ok_or_else(|| bad_payload("missing 'capabilities'"))?;
        store.set_capabilities(&required_str(intent, "id")?, capabilities);
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.disconnect", move |intent, projector| {
        let store = store_of(&handle)?;
        store.disconnect(&required_str(intent, "id")?);
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.refresh", move |intent, projector| {
        let store = store_of(&handle)?;
        store.refresh(
            &required_str(intent, "id")?,
            required_list(intent, "sessions")?,
            required_list(intent, "definitions")?,
            required_list(intent, "folders")?,
        );
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.clearSessions", move |intent, projector| {
        let store = store_of(&handle)?;
        store.clear_sessions(&required_str(intent, "id")?);
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.saveDefinition", move |intent, projector| {
        let store = store_of(&handle)?;
        store.save_definition(&required_str(intent, "id")?, required_definition(intent)?);
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.updateDefinition", move |intent, projector| {
        let store = store_of(&handle)?;
        store.update_definition(&required_str(intent, "id")?, required_definition(intent)?);
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.deleteDefinition", move |intent, projector| {
        let store = store_of(&handle)?;
        store.delete_definition(
            &required_str(intent, "id")?,
            &required_str(intent, "definitionId")?,
        );
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.createFolder", move |intent, projector| {
        let store = store_of(&handle)?;
        store.create_folder(&required_str(intent, "id")?, required_folder(intent)?);
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("agent.updateFolder", move |intent, projector| {
        let store = store_of(&handle)?;
        store.update_folder(&required_str(intent, "id")?, required_folder(intent)?);
        Ok(publish_agents(projector, &store))
    });

    let handle = app_handle;
    registry.route("agent.deleteFolder", move |intent, projector| {
        let store = store_of(&handle)?;
        store.delete_folder(
            &required_str(intent, "id")?,
            &required_str(intent, "folderId")?,
        );
        Ok(publish_agents(projector, &store))
    });
}

/// Resolve the managed agents store, or a rejectable error if absent.
fn store_of(app_handle: &AppHandle) -> Result<Arc<AgentsStore>, (String, String)> {
    app_handle
        .try_state::<Arc<AgentsStore>>()
        .map(|state| (*state).clone())
        .ok_or_else(|| {
            (
                "unavailable".to_string(),
                "agents store is not initialized".to_string(),
            )
        })
}

/// Build a `bad_payload` rejection with a message.
fn bad_payload(message: &str) -> (String, String) {
    ("bad_payload".to_string(), message.to_string())
}

/// Extract a required string field from an intent payload.
fn required_str(intent: &Intent, key: &str) -> Result<String, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| bad_payload(&format!("missing '{key}'")))
}

/// Extract an optional string field; absent → `None`.
fn optional_str(intent: &Intent, key: &str) -> Option<String> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Extract an optional JSON field; absent → `Value::Null` (an agent added without
/// a config carries a null blob, matching an unset frontend field).
fn optional_value(intent: &Intent, key: &str) -> Value {
    intent.payload.get(key).cloned().unwrap_or(Value::Null)
}

/// Extract a required array index (`usize`) field from an intent payload.
fn required_usize(intent: &Intent, key: &str) -> Result<usize, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .ok_or_else(|| bad_payload(&format!("missing '{key}'")))
}

/// Parse the required `state` field as an [`AgentConnectionState`].
fn required_state(intent: &Intent) -> Result<AgentConnectionState, (String, String)> {
    let value = intent
        .payload
        .get("state")
        .ok_or_else(|| bad_payload("missing 'state'"))?;
    serde_json::from_value(value.clone())
        .map_err(|e| bad_payload(&format!("invalid state: {e}")))
}

/// Parse the required `definition` object as an [`AgentDefinition`].
fn required_definition(intent: &Intent) -> Result<AgentDefinition, (String, String)> {
    let value = intent
        .payload
        .get("definition")
        .ok_or_else(|| bad_payload("missing 'definition'"))?;
    serde_json::from_value(value.clone())
        .map_err(|e| bad_payload(&format!("invalid definition: {e}")))
}

/// Parse the required `folder` object as an [`AgentFolder`].
fn required_folder(intent: &Intent) -> Result<AgentFolder, (String, String)> {
    let value = intent
        .payload
        .get("folder")
        .ok_or_else(|| bad_payload("missing 'folder'"))?;
    serde_json::from_value(value.clone())
        .map_err(|e| bad_payload(&format!("invalid folder: {e}")))
}

/// Parse a required array field as a typed list (used for `agent.refresh`'s
/// `sessions` / `definitions` / `folders`).
fn required_list<T: serde::de::DeserializeOwned>(
    intent: &Intent,
    key: &str,
) -> Result<Vec<T>, (String, String)> {
    let value = intent
        .payload
        .get(key)
        .ok_or_else(|| bad_payload(&format!("missing '{key}'")))?;
    serde_json::from_value(value.clone())
        .map_err(|e| bad_payload(&format!("invalid {key}: {e}")))
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
