//! The setup wizard stores the Windows install path it resolved as the
//! agent's `agentPath`, and the agents region carries it (#5522).

use std::sync::Arc;

use tauri::test::MockRuntime;
use tauri::{App, Manager};

use super::*;
use crate::agents_projection::store::AgentsStore;
use crate::connection::config::SavedRemoteAgent;
use crate::connection::manager::ConnectionManager;

const ENCODED: &str = "C:/Users/me/AppData/Local/termiHub/agent/termihub-agent.exe";

fn app_with_agent() -> (tempfile::TempDir, App<MockRuntime>, Arc<AgentsStore>) {
    let dir = tempfile::tempdir().unwrap();
    let manager =
        ConnectionManager::new_for_test(dir.path(), Arc::new(crate::credential::NullStore))
            .unwrap();
    let agent: SavedRemoteAgent = serde_json::from_value(serde_json::json!({
        "id": "a1",
        "name": "Win",
        "config": { "host": "win", "port": 22, "username": "u" },
    }))
    .unwrap();
    manager.save_agent(agent).unwrap();
    let app = tauri::test::mock_app();
    app.manage(manager);
    let agents = Arc::new(AgentsStore::new());
    app.manage(agents.clone());
    (dir, app, agents)
}

fn stored_agent_path(app: &App<MockRuntime>) -> Option<String> {
    let view = app
        .state::<ConnectionManager>()
        .load_unified_view()
        .unwrap();
    view.agents
        .into_iter()
        .find(|a| a.id == "a1")
        .and_then(|a| a.config.agent_path)
}

#[test]
fn a_resolved_setup_path_is_saved_and_reaches_the_agents_region() {
    let (_dir, app, agents) = app_with_agent();
    record_setup_install_path(app.handle(), "a1", Ok(ENCODED.to_string()));

    assert_eq!(stored_agent_path(&app).as_deref(), Some(ENCODED));
    let region = agents.get("a1").expect("folded into the region");
    assert_eq!(region.config["agentPath"], serde_json::json!(ENCODED));
}

#[test]
fn the_saved_setup_path_is_what_the_next_connect_runs() {
    let (_dir, app, _agents) = app_with_agent();
    record_setup_install_path(app.handle(), "a1", Ok(ENCODED.to_string()));
    let view = app
        .state::<ConnectionManager>()
        .load_unified_view()
        .unwrap();
    let config = &view.agents[0].config;
    assert_eq!(config.agent_exec_command(), format!("{ENCODED} --stdio"));
}

#[test]
fn an_unresolvable_setup_path_keeps_the_stored_path() {
    let (_dir, app, _agents) = app_with_agent();
    record_setup_install_path(
        app.handle(),
        "a1",
        Err(TerminalError::RemoteError("no usable path".to_string())),
    );
    assert_eq!(stored_agent_path(&app), None);
}
