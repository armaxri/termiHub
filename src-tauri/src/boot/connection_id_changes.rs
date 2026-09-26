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
//! * **open tabs** — tab content (`connectionId` / `persistentConnectionId`) is
//!   window-local frontend state (the backend `layout@<client>` region holds the
//!   panel structure only), so every window is told via
//!   [`CONNECTION_IDS_CHANGED_EVENT`] and re-points its own tabs.

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::connection::manager::{ConnectionIdChange, ConnectionManager};

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
    connections.set_id_change_listener(std::sync::Arc::new(move |changes| {
        crate::files::bookmarks_manager::follow_connection_renames(&handle, changes);
        announce_connection_id_changes(&handle, changes);
    }));
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

    #[test]
    fn without_a_connection_manager_registering_is_a_no_op() {
        let app = tauri::test::mock_app();
        follow_connection_id_changes(app.handle());
    }
}
