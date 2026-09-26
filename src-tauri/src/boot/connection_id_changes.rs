//! Everything keyed by a saved connection's id follows the id when it changes
//! (#3569, #3579).
//!
//! A saved connection's id is its path in the tree (`Folder/Name`), so renaming
//! or moving it — or renaming, moving or deleting a folder above it — changes
//! the id. The [`ConnectionManager`] reports every change it persists to a
//! single listener; this boot phase registers that listener and fans each batch
//! out to the id's dependents:
//!
//! * **file-browser bookmarks** — re-keyed in the backend store, which then
//!   emits `file-bookmarks-rekeyed` for the UI cache
//!   ([`crate::files::bookmarks_manager::follow_connection_renames`]);
//! * **saved records referencing a connection** (#3596) — re-keyed in their
//!   backend stores, each persisted atomically on its own:
//!   * saved workspaces' and the stored last session's tab `connectionRef`s;
//!   * SSH tunnels' `sshConnectionId` (the `tunnels` region is republished);
//!   * schedules targeting connections (then `schedules-changed` is emitted);
//!   * workflows' on-connect triggers;
//!   * jump-host references, broadcast groups and shell-integration entries,
//!     which the [`ConnectionManager`] itself rewrites before it reports the
//!     batch — the jump-host references of the file that changed in the very
//!     same write (see `ConnectionManager::follow_references`); here the
//!     rewritten settings are only reflected into the `settings` region;
//! * **open tabs** — tab content (`connectionId` / `persistentConnectionId`) is
//!   window-local frontend state (the backend `layout@<client>` region holds the
//!   panel structure only), so every window is told via
//!   [`CONNECTION_IDS_CHANGED_EVENT`] and re-points its own tabs. The event is
//!   sent last, after every store above followed, so a window re-reading a store
//!   in response (the workflow list) sees the new ids.
//!
//! A store that fails to follow logs the failure and keeps its old references
//! (they dangle, as before #3596); it never blocks the other stores, and the
//! rename itself is already persisted. Session history deliberately keeps the
//! old ids: it records what was opened, when. Agent-hosted definitions never
//! reference a desktop connection id (their jump hosts are inline; an
//! agent-hosted tunnel's connection is resolved on the desktop), so nothing on
//! an agent follows.

use std::fmt::Display;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::connection::id_changes::ConnectionIdRemap;
use crate::connection::manager::{ConnectionIdChange, ConnectionManager};
use crate::schedules::manager::ScheduleManager;
use crate::schedules::runner::EVENT_SCHEDULES_CHANGED;
use crate::tunnel::tunnel_manager::TunnelManager;
use crate::workflows::manager::WorkflowManager;
use crate::workspace::last_session::LastSessionManager;
use crate::workspace::manager::WorkspaceManager;

/// Event telling every window that saved connections' ids changed (#3579). The
/// payload is the persisted operation's `[{ oldId, newId }]` list; the changes
/// of one payload apply simultaneously (a swap `a→b, b→a` is two changes).
pub const CONNECTION_IDS_CHANGED_EVENT: &str = "connection-ids-changed";

/// Register the [`ConnectionManager`] id-change listener. Call once, after the
/// connection and bookmark managers are managed; without a connection manager
/// this is a no-op.
pub(crate) fn follow_connection_id_changes<R: Runtime>(app: &AppHandle<R>) {
    let Some(connections) = app.try_state::<ConnectionManager>() else {
        return;
    };
    let handle = app.clone();
    connections.set_id_change_listener(Arc::new(move |changes| {
        follow_saved_references(&handle, changes);
        crate::files::bookmarks_manager::follow_connection_renames(&handle, changes);
        announce_connection_id_changes(&handle, changes);
    }));
}

/// Re-key the saved records that reference a connection by id (#3596). Every
/// managed store applies the whole batch at once; a missing store is skipped
/// and a failing one is logged without stopping the others.
fn follow_saved_references<R: Runtime>(app: &AppHandle<R>, changes: &[ConnectionIdChange]) {
    let remap = ConnectionIdRemap::new(changes);
    if remap.is_empty() {
        return;
    }
    // Broadcast groups and shell entries were rewritten by the connection
    // manager; show every window the persisted document.
    crate::settings_projection::projection::fold_settings_from_manager(app);

    if let Some(workspaces) = app.try_state::<WorkspaceManager>() {
        followed(
            "saved workspaces",
            workspaces.follow_connection_id_changes(&remap),
        );
    }
    if let Some(last_session) = app.try_state::<LastSessionManager>() {
        followed(
            "the last session",
            last_session.follow_connection_id_changes(&remap),
        );
    }
    if let Some(workflows) = app.try_state::<WorkflowManager>() {
        followed(
            "workflow triggers",
            workflows.follow_connection_id_changes(&remap),
        );
    }
    if let Some(tunnels) = app.try_state::<Arc<TunnelManager>>() {
        if followed("SSH tunnels", tunnels.follow_connection_id_changes(&remap)) {
            crate::tunnel::projection::publish_tunnels(app);
        }
    }
    if let Some(schedules) = app.try_state::<Arc<ScheduleManager>>() {
        if followed("schedules", schedules.follow_connection_id_changes(&remap)) {
            if let Err(e) = app.emit(EVENT_SCHEDULES_CHANGED, ()) {
                tracing::warn!("Failed to emit {EVENT_SCHEDULES_CHANGED}: {e}");
            }
        }
    }
}

/// Log the outcome of one store following an id-change batch; returns whether
/// the store changed.
fn followed<E: Display>(what: &str, outcome: Result<bool, E>) -> bool {
    match outcome {
        Ok(changed) => {
            if changed {
                tracing::info!("Re-pointed {what} at renamed connections");
            }
            changed
        }
        Err(e) => {
            tracing::warn!(
                "Failed to re-point {what} at renamed connections; they keep the old ids: {e}"
            );
            false
        }
    }
}

/// Tell every window which saved-connection ids changed, so open tabs follow.
fn announce_connection_id_changes<R: Runtime>(app: &AppHandle<R>, changes: &[ConnectionIdChange]) {
    if changes.is_empty() {
        return;
    }
    if let Err(e) = app.emit(CONNECTION_IDS_CHANGED_EVENT, changes) {
        tracing::warn!("Failed to announce connection id changes: {e}");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tauri::Listener;

    use super::*;
    use crate::connection::config::{ConnectionFolder, SavedConnection};
    use crate::credential::null::NullStore;
    use crate::files::bookmarks_manager::{
        connection_scope, FileBookmarkManager, FILE_BOOKMARKS_REKEYED_EVENT,
    };
    use crate::terminal::backend::ConnectionConfig;

    fn conn(id: &str, name: &str, folder_id: Option<&str>) -> SavedConnection {
        SavedConnection {
            icon: None,
            id: id.to_string(),
            name: name.to_string(),
            config: ConnectionConfig {
                type_id: "local".to_string(),
                settings: serde_json::json!({"shell": "bash"}),
            },
            folder_id: folder_id.map(String::from),
            terminal_options: None,
            source_file: None,
        }
    }

    fn folder(id: &str, name: &str) -> ConnectionFolder {
        ConnectionFolder {
            id: id.to_string(),
            name: name.to_string(),
            parent_id: None,
            is_expanded: true,
        }
    }

    /// Record the JSON payloads of every `event` emitted by `app`.
    fn record<R: Runtime>(app: &AppHandle<R>, event: &str) -> Arc<Mutex<Vec<serde_json::Value>>> {
        let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
        let sink = seen.clone();
        app.listen_any(event, move |e| {
            sink.lock()
                .unwrap()
                .push(serde_json::from_str(e.payload()).unwrap());
        });
        seen
    }

    #[test]
    fn a_folder_rename_announces_id_changes_and_moves_bookmarks() {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap());
        app.manage(FileBookmarkManager::new_for_test(dir.path()).unwrap());
        follow_connection_id_changes(app.handle());
        let ids_changed = record(app.handle(), CONNECTION_IDS_CHANGED_EVENT);
        let rekeyed = record(app.handle(), FILE_BOOKMARKS_REKEYED_EVENT);

        let mgr = app.state::<ConnectionManager>();
        mgr.save_folder(folder("Work", "Work")).unwrap();
        mgr.save_connection(conn("x", "x", Some("Work"))).unwrap();
        app.state::<FileBookmarkManager>()
            .add(&connection_scope("Work/x"), "/srv", None)
            .unwrap();
        ids_changed.lock().unwrap().clear();

        mgr.save_folder(folder("Work", "Job")).unwrap();

        assert_eq!(
            *ids_changed.lock().unwrap(),
            vec![serde_json::json!([{ "oldId": "Work/x", "newId": "Job/x" }])]
        );
        assert_eq!(
            *rekeyed.lock().unwrap(),
            vec![serde_json::json!([{ "from": "connection:Work/x", "to": "connection:Job/x" }])]
        );
    }

    #[test]
    fn id_changes_are_announced_without_a_bookmark_manager() {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap());
        follow_connection_id_changes(app.handle());
        let ids_changed = record(app.handle(), CONNECTION_IDS_CHANGED_EVENT);

        let mgr = app.state::<ConnectionManager>();
        mgr.save_connection(conn("a", "a", None)).unwrap();
        mgr.save_connection(conn("a", "b", None)).unwrap();

        assert_eq!(
            *ids_changed.lock().unwrap(),
            vec![serde_json::json!([{ "oldId": "a", "newId": "b" }])]
        );
    }

    #[test]
    fn saving_without_an_id_change_announces_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap());
        follow_connection_id_changes(app.handle());
        let ids_changed = record(app.handle(), CONNECTION_IDS_CHANGED_EVENT);

        let mgr = app.state::<ConnectionManager>();
        mgr.save_connection(conn("a", "a", None)).unwrap();
        mgr.save_connection(conn("a", "a", None)).unwrap();

        assert!(ids_changed.lock().unwrap().is_empty());
    }

    /// #3596: a folder rename re-points every saved record that references a
    /// connection in it, and each still resolves to the renamed connection.
    #[test]
    fn a_folder_rename_moves_saved_records_to_the_new_ids() {
        use crate::schedules::config::{
            MissedRunPolicy, ScheduleAction, ScheduleRule, ScheduleTargets,
        };
        use crate::schedules::manager::ScheduleInput;
        use crate::workflows::config::{Workflow, WorkflowTrigger};
        use crate::workspace::config::{
            WorkspaceDefinition, WorkspaceLayoutNode, WorkspaceTabDef, WorkspaceTabGroupDef,
        };
        use crate::workspace::last_session::LastSession;

        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap());
        app.manage(WorkspaceManager::new_for_test(dir.path()));
        app.manage(LastSessionManager::new_for_test(dir.path()));
        app.manage(WorkflowManager::new_for_test(dir.path()));
        app.manage(Arc::new(ScheduleManager::new_test(dir.path())));
        follow_connection_id_changes(app.handle());
        let ids_changed = record(app.handle(), CONNECTION_IDS_CHANGED_EVENT);
        let schedules_changed = record(app.handle(), EVENT_SCHEDULES_CHANGED);

        let mgr = app.state::<ConnectionManager>();
        mgr.save_folder(folder("Work", "Work")).unwrap();
        mgr.save_connection(conn("x", "x", Some("Work"))).unwrap();

        let groups = || {
            vec![WorkspaceTabGroupDef {
                name: "Main".to_string(),
                color: None,
                window_id: None,
                layout: WorkspaceLayoutNode::Leaf {
                    tabs: vec![WorkspaceTabDef {
                        connection_ref: Some("Work/x".to_string()),
                        inline_config: None,
                        agent_ref: None,
                        title: None,
                        initial_command: None,
                    }],
                },
            }]
        };
        app.state::<WorkspaceManager>()
            .save_workspace(WorkspaceDefinition {
                id: "ws".to_string(),
                name: "ws".to_string(),
                description: None,
                tab_groups: groups(),
                windows: None,
                settings: None,
            })
            .unwrap();
        app.state::<LastSessionManager>()
            .save(LastSession {
                version: "1".to_string(),
                tab_groups: groups(),
                active_group_index: 0,
                windows: None,
                active_workspace_id: None,
                extra: Default::default(),
            })
            .unwrap();
        app.state::<WorkflowManager>()
            .save_workflow(Workflow {
                id: "wf".to_string(),
                name: "wf".to_string(),
                description: None,
                tags: vec![],
                steps: vec![],
                triggers: vec![WorkflowTrigger::OnConnect {
                    connection_ids: vec!["Work/x".to_string()],
                }],
                parameters: Vec::new(),
                created_at: String::new(),
                updated_at: String::new(),
            })
            .unwrap();
        let now = chrono::Utc::now();
        app.state::<Arc<ScheduleManager>>()
            .save(
                ScheduleInput {
                    id: "s".to_string(),
                    name: "s".to_string(),
                    action: ScheduleAction::Workflow {
                        workflow_id: "wf".to_string(),
                    },
                    targets: ScheduleTargets::Connections {
                        connection_ids: vec!["Work/x".to_string()],
                    },
                    rule: ScheduleRule::Interval { every_minutes: 5 },
                    missed_runs: MissedRunPolicy::Skip,
                },
                now,
                &chrono::Utc,
            )
            .unwrap();
        ids_changed.lock().unwrap().clear();

        mgr.save_folder(folder("Work", "Job")).unwrap();

        // Every record now names an id the connection manager resolves.
        let live: Vec<String> = mgr
            .get_all()
            .unwrap()
            .connections
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(live, ["Job/x"]);
        let tab_ref = |groups: &[WorkspaceTabGroupDef]| match &groups[0].layout {
            WorkspaceLayoutNode::Leaf { tabs } => tabs[0].connection_ref.clone(),
            _ => panic!("leaf expected"),
        };
        let ws = app
            .state::<WorkspaceManager>()
            .load_workspace("ws")
            .unwrap();
        assert_eq!(tab_ref(&ws.tab_groups).as_deref(), Some("Job/x"));
        let session = app.state::<LastSessionManager>().load().unwrap().unwrap();
        assert_eq!(tab_ref(&session.tab_groups).as_deref(), Some("Job/x"));
        let wf = app.state::<WorkflowManager>().get_workflow("wf").unwrap();
        assert_eq!(
            wf.triggers,
            vec![WorkflowTrigger::OnConnect {
                connection_ids: vec!["Job/x".to_string()],
            }]
        );
        let schedules = app
            .state::<Arc<ScheduleManager>>()
            .state(now, &chrono::Utc)
            .unwrap();
        assert_eq!(
            schedules.schedules[0].schedule.targets,
            ScheduleTargets::Connections {
                connection_ids: vec!["Job/x".to_string()],
            }
        );
        // The frontend is told: the schedule list reloads, tabs follow.
        assert_eq!(schedules_changed.lock().unwrap().len(), 1);
        assert_eq!(ids_changed.lock().unwrap().len(), 1);
    }

    #[test]
    fn without_a_connection_manager_registering_is_a_no_op() {
        let app = tauri::test::mock_app();
        follow_connection_id_changes(app.handle());
    }
}
