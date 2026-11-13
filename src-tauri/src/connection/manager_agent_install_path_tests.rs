//! A deploy/setup's reported install path becomes the saved agent's
//! `agentPath`, and the next connect launches it (#5522).

use std::sync::Arc;

use super::*;
use crate::credential::null::NullStore;

const ENCODED: &str = "C:/Users/me/AppData/Local/termiHub/agent/termihub-agent.exe";
const RESOLVED: &str = r"C:\Users\Jane Doe\AppData\Local\termiHub\agent\termihub-agent.exe";

fn manager_with_agent(agent_path: Option<&str>) -> (tempfile::TempDir, ConnectionManager) {
    let dir = tempfile::tempdir().unwrap();
    let manager = ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap();
    let mut config = serde_json::json!({ "host": "win", "port": 22, "username": "u" });
    if let Some(path) = agent_path {
        config["agentPath"] = serde_json::json!(path);
    }
    let agent: SavedRemoteAgent =
        serde_json::from_value(serde_json::json!({ "id": "a1", "name": "Win", "config": config }))
            .unwrap();
    manager.save_agent(agent).unwrap();
    (dir, manager)
}

fn stored_config(manager: &ConnectionManager) -> crate::terminal::backend::RemoteAgentConfig {
    manager
        .load_unified_view()
        .unwrap()
        .agents
        .into_iter()
        .find(|a| a.id == "a1")
        .expect("agent a1")
        .config
}

#[test]
fn a_windows_deploy_result_updates_the_saved_agent() {
    let (_dir, manager) = manager_with_agent(None);
    assert!(manager.record_agent_install_path("a1", ENCODED).unwrap());
    assert_eq!(stored_config(&manager).agent_path.as_deref(), Some(ENCODED));
}

#[test]
fn the_next_connect_launches_the_recorded_path() {
    let (_dir, manager) = manager_with_agent(None);
    manager.record_agent_install_path("a1", ENCODED).unwrap();
    assert_eq!(
        stored_config(&manager).agent_exec_command(),
        format!("{ENCODED} --stdio")
    );

    // A resolved cmd/PowerShell path with a space goes through `cmd /c`.
    let (_dir, manager) = manager_with_agent(None);
    manager.record_agent_install_path("a1", RESOLVED).unwrap();
    assert_eq!(
        stored_config(&manager).agent_exec_command(),
        format!("cmd /c \"{RESOLVED}\" --stdio")
    );
}

#[test]
fn the_recorded_path_survives_a_reload_from_disk() {
    let (dir, manager) = manager_with_agent(None);
    manager.record_agent_install_path("a1", ENCODED).unwrap();
    let reloaded = ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap();
    assert_eq!(
        stored_config(&reloaded).agent_path.as_deref(),
        Some(ENCODED)
    );
}

#[test]
fn a_user_set_custom_path_is_kept() {
    let custom = r"C:\tools\termihub-agent.exe";
    let (_dir, manager) = manager_with_agent(Some(custom));
    assert!(!manager.record_agent_install_path("a1", ENCODED).unwrap());
    assert_eq!(stored_config(&manager).agent_path.as_deref(), Some(custom));
}

#[test]
fn a_posix_install_leaves_the_agent_untouched() {
    let (_dir, manager) = manager_with_agent(None);
    assert!(!manager
        .record_agent_install_path("a1", "~/.local/bin/termihub-agent")
        .unwrap());
    assert_eq!(stored_config(&manager).agent_path, None);
}

#[test]
fn an_unknown_agent_is_an_error() {
    let (_dir, manager) = manager_with_agent(None);
    assert!(manager.record_agent_install_path("nope", ENCODED).is_err());
}
