//! Every connection-config command that mutates (or reloads) the
//! [`ConnectionManager`] re-folds its authoritative projection region through the
//! single [`commit`] choke point (TAURI-006, #3762).
//!
//! The commands are driven end to end against a `tauri::test::mock_app()` carrying
//! the managed state `boot` wires: a real temp-dir [`ConnectionManager`], the
//! three stores it folds into, and a [`ProjectionState`] with every region
//! registered. Before each command every store is *poisoned* with a sentinel the
//! manager does not hold, so "the sentinel is gone" proves the fold ran and "the
//! sentinel survived" proves it did not — for every region, not only the one the
//! command is meant to feed.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tauri::test::MockRuntime;
use tauri::{App, Manager};

use super::*;
use crate::agents_projection::projection::AGENTS_REGION;
use crate::agents_projection::store::{AgentsStore, SavedAgentSeed};
use crate::commands::projection::ProjectionState;
use crate::connections_projection::projection::CONNECTIONS_REGION;
use crate::connections_projection::store::ConnectionsStore;
use crate::projection::{ProjectionError, ProjectionFrame, ProjectionSink};
use crate::settings_projection::projection::SETTINGS_REGION;
use crate::settings_projection::store::SettingsStore;
use crate::terminal::backend::ConnectionConfig;

const SENTINEL: &str = "__fold_sentinel__";

/// Records the region of every diff it receives, in delivery order, across all
/// the regions it is subscribed to.
#[derive(Default)]
struct OrderSink {
    regions: Mutex<Vec<String>>,
}

impl ProjectionSink for OrderSink {
    fn deliver(&self, frame: &ProjectionFrame) -> Result<(), ProjectionError> {
        if let ProjectionFrame::Diff(diff) = frame {
            self.regions.lock().unwrap().push(diff.region.clone());
        }
        Ok(())
    }
}

struct Harness {
    app: App<MockRuntime>,
    connections: Arc<ConnectionsStore>,
    agents: Arc<AgentsStore>,
    settings: Arc<SettingsStore>,
    sink: Arc<OrderSink>,
    dir: tempfile::TempDir,
}

fn connection(name: &str, folder_id: Option<&str>) -> SavedConnection {
    SavedConnection {
        icon: None,
        id: format!("conn-{name}"),
        name: name.to_string(),
        config: ConnectionConfig {
            type_id: "ssh".to_string(),
            settings: json!({ "host": "example.com", "port": 22 }),
        },
        folder_id: folder_id.map(str::to_string),
        terminal_options: None,
        source_file: None,
    }
}

fn folder(id: &str) -> ConnectionFolder {
    ConnectionFolder {
        id: id.to_string(),
        name: id.to_string(),
        parent_id: None,
        is_expanded: true,
    }
}

fn agent(id: &str) -> SavedRemoteAgent {
    serde_json::from_value(json!({
        "id": id,
        "name": id,
        "config": { "host": "agent.example.com", "port": 22, "username": "u" },
    }))
    .expect("valid agent fixture")
}

/// A mock app wired like `boot`, with a manager already holding one folder, one
/// connection (`Work/Host`) and two agents (`a1`, `a2`).
fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let manager =
        ConnectionManager::new_for_test(dir.path(), Arc::new(crate::credential::NullStore))
            .unwrap();
    manager.save_folder(folder("Work")).unwrap();
    manager
        .save_connection(connection("Host", Some("Work")))
        .unwrap();
    manager.save_agent(agent("a1")).unwrap();
    manager.save_agent(agent("a2")).unwrap();

    let app = tauri::test::mock_app();
    app.manage(manager);
    let connections = Arc::new(ConnectionsStore::new());
    let agents = Arc::new(AgentsStore::new());
    let settings = Arc::new(SettingsStore::new());
    app.manage(connections.clone());
    app.manage(agents.clone());
    app.manage(settings.clone());

    let projection = ProjectionState::new();
    let sink = Arc::new(OrderSink::default());
    for (region, snapshot) in [
        (CONNECTIONS_REGION, connections.snapshot()),
        (AGENTS_REGION, agents.snapshot()),
        (SETTINGS_REGION, settings.snapshot()),
    ] {
        projection.projector.register_region(region, snapshot);
        projection
            .projector
            .subscribe(region, format!("sub-{region}"), "C", sink.clone());
    }
    app.manage(projection);

    Harness {
        app,
        connections,
        agents,
        settings,
        sink,
        dir,
    }
}

impl Harness {
    fn manager(&self) -> tauri::State<'_, ConnectionManager> {
        self.app.state::<ConnectionManager>()
    }

    fn handle(&self) -> AppHandle<MockRuntime> {
        self.app.handle().clone()
    }

    /// Put a sentinel the manager does not hold into every store, and forget the
    /// diffs recorded so far.
    fn poison(&self) {
        self.connections
            .replace(Vec::new(), vec![connection(SENTINEL, None)]);
        self.agents.reflect_saved_agents(vec![SavedAgentSeed {
            id: SENTINEL.to_string(),
            name: SENTINEL.to_string(),
            config: json!({}),
            agent_settings: json!({}),
        }]);
        let mut doc = Map::new();
        doc.insert(SENTINEL.to_string(), Value::Bool(true));
        self.settings.replace(doc);
        self.sink.regions.lock().unwrap().clear();
    }

    /// The regions whose store was re-folded from the manager since [`poison`].
    fn folded(&self) -> Vec<Fold> {
        let mut folded = Vec::new();
        if self
            .connections
            .connection(&format!("conn-{SENTINEL}"))
            .is_none()
        {
            folded.push(Fold::Connections);
        }
        if !self.agents.agent_ids().iter().any(|id| id == SENTINEL) {
            folded.push(Fold::Agents);
        }
        if self.settings.snapshot().get(SENTINEL).is_none() {
            folded.push(Fold::Settings);
        }
        folded
    }

    /// The regions that published a diff since [`poison`], in delivery order.
    fn published(&self) -> Vec<String> {
        self.sink.regions.lock().unwrap().clone()
    }
}

fn connection_id(h: &Harness) -> String {
    h.manager()
        .load_unified_view()
        .unwrap()
        .connections
        .into_iter()
        .find(|c| c.name == "Host")
        .expect("seeded connection")
        .id
}

/// A command invocation against the harness; returns whether it succeeded.
type Invoke = fn(&Harness) -> bool;

/// Every connection-config command that touches the manager, with the regions it
/// must re-fold. A new mutating command belongs here — the source guard below
/// fails until it is listed.
fn mutating_commands() -> Vec<(&'static str, Vec<Fold>, Invoke)> {
    vec![
        (
            "load_connections_and_folders",
            vec![Fold::Connections, Fold::Agents],
            |h| load_connections_and_folders(h.handle(), h.manager()).is_ok(),
        ),
        ("save_connection", vec![Fold::Connections], |h| {
            save_connection(connection("New", None), h.handle(), h.manager()).is_ok()
        }),
        ("delete_connection", vec![Fold::Connections], |h| {
            delete_connection(connection_id(h), None, h.handle(), h.manager()).is_ok()
        }),
        ("move_connection_to_file", vec![Fold::Connections], |h| {
            let target = h.dir.path().join("external.json");
            let target = Some(target.to_string_lossy().into_owned());
            move_connection_to_file(connection_id(h), None, target, h.handle(), h.manager()).is_ok()
        }),
        ("save_connection_to_file", vec![Fold::Connections], |h| {
            let mut edited = connection("Host", Some("Work"));
            edited.id = connection_id(h);
            let target = h.dir.path().join("external.json");
            edited.source_file = Some(target.to_string_lossy().into_owned());
            save_connection_to_file(edited, None, h.handle(), h.manager()).is_ok()
        }),
        ("save_folder", vec![Fold::Connections], |h| {
            save_folder(folder("Other"), h.handle(), h.manager()).is_ok()
        }),
        ("delete_folder", vec![Fold::Connections], |h| {
            delete_folder("Work".to_string(), h.handle(), h.manager()).is_ok()
        }),
        ("import_connections", vec![Fold::Connections], |h| {
            let json = h.manager().export_json().unwrap();
            import_connections(json, h.handle(), h.manager()).is_ok()
        }),
        ("save_settings", vec![Fold::Settings], |h| {
            save_settings(AppSettings::default(), h.handle(), h.manager()).is_ok()
        }),
        ("save_external_file", vec![Fold::Connections], |h| {
            let path = h.dir.path().join("saved-external.json");
            save_external_file(
                path.to_string_lossy().into_owned(),
                "External".to_string(),
                Vec::new(),
                vec![connection("Ext", None)],
                h.handle(),
                h.manager(),
            )
            .is_ok()
        }),
        (
            "reload_external_connections",
            vec![Fold::Connections],
            |h| reload_external_connections(h.handle(), h.manager()).is_ok(),
        ),
        ("save_remote_agent", vec![Fold::Agents], |h| {
            save_remote_agent(agent("a3"), h.handle(), h.manager()).is_ok()
        }),
        ("delete_remote_agent", vec![Fold::Agents], |h| {
            delete_remote_agent("a1".to_string(), h.handle(), h.manager()).is_ok()
        }),
        ("reorder_remote_agents", vec![Fold::Agents], |h| {
            let ids = vec!["a2".to_string(), "a1".to_string()];
            reorder_remote_agents(ids, h.handle(), h.manager()).is_ok()
        }),
        ("reorder_connections", vec![Fold::Connections], |h| {
            reorder_connections(vec![connection_id(h)], h.handle(), h.manager()).is_ok()
        }),
        (
            "import_connections_with_credentials",
            vec![Fold::Connections],
            |h| {
                let dir = tempfile::tempdir().unwrap();
                h.app.manage(Arc::new(CredentialManager::new(
                    StorageMode::None,
                    dir.path().to_path_buf(),
                )));
                h.app.manage(Arc::new(NamedCredentialRegistry::in_memory()));
                let json = h.manager().export_encrypted_json(None, None).unwrap();
                tauri::async_runtime::block_on(import_connections_with_credentials(
                    json,
                    None,
                    h.handle(),
                    h.manager(),
                    h.app.state::<Arc<CredentialManager>>(),
                    h.app.state::<Arc<NamedCredentialRegistry>>(),
                ))
                .is_ok()
            },
        ),
    ]
}

/// Commands in `connection.rs` that read but never mutate the manager, so they
/// fold nothing.
const READ_ONLY_COMMANDS: &[&str] = &[
    "export_connections",
    "get_settings",
    "export_connections_encrypted",
    "preview_import",
    "get_recovery_warnings",
];

/// Every mutating command succeeds and re-folds exactly the regions it names —
/// the stores then mirror the manager again — and no other region.
#[test]
fn every_mutating_command_refolds_exactly_its_regions() {
    for (name, expected, invoke) in mutating_commands() {
        let h = harness();
        h.poison();
        assert!(invoke(&h), "{name} succeeds");

        let mut expected = expected;
        let order = |f: &Fold| *f as u8;
        expected.sort_by_key(order);
        assert_eq!(h.folded(), expected, "{name} re-folds exactly {expected:?}");

        if expected.contains(&Fold::Connections) {
            let view = h.manager().load_unified_view().unwrap();
            let stored: Vec<String> = h
                .connections
                .snapshot()
                .get("connections")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|r| r["id"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let authority: Vec<String> = view.connections.into_iter().map(|c| c.id).collect();
            assert_eq!(stored, authority, "{name}: connections mirror the manager");
        }
        if expected.contains(&Fold::Agents) {
            let view = h.manager().load_unified_view().unwrap();
            let authority: Vec<String> = view.agents.into_iter().map(|a| a.id).collect();
            assert_eq!(h.agents.agent_ids(), authority, "{name}: agents mirror");
        }
    }
}

/// A reload folds agents before connections — the order the command used before
/// the choke point existed, observed on the published region diffs.
#[test]
fn load_folds_agents_then_connections() {
    let h = harness();
    h.poison();
    load_connections_and_folders(h.handle(), h.manager()).unwrap();
    assert_eq!(h.published(), vec![AGENTS_REGION, CONNECTIONS_REGION]);
}

/// A rejected mutation folds nothing, so no region republishes.
#[test]
fn failed_mutation_folds_nothing() {
    let h = harness();
    h.poison();
    assert!(import_connections("not json".to_string(), h.handle(), h.manager()).is_err());
    assert!(h.folded().is_empty(), "a failed op re-folds no region");
    assert!(h.published().is_empty(), "a failed op publishes no diff");
}

/// The body of each `#[tauri::command]` fn in `connection.rs`, by name.
fn command_bodies(source: &str) -> Vec<(String, String)> {
    let mut commands = Vec::new();
    let chunks: Vec<&str> = source.split("#[tauri::command]").collect();
    for chunk in chunks.iter().skip(1) {
        let header = chunk
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("pub fn") || l.starts_with("pub async fn"))
            .expect("a command fn follows the attribute");
        let name = header
            .trim_start_matches("pub async fn ")
            .trim_start_matches("pub fn ")
            .split(['(', '<'])
            .next()
            .unwrap()
            .to_string();
        // A command's body ends where the next item's doc comment or attribute
        // begins; good enough to scan for a `commit(` call.
        commands.push((name, chunk.to_string()));
    }
    commands
}

/// Source guard: every command in `connection.rs` is classified as mutating
/// (listed above, and folds through `commit`) or read-only, and no command calls
/// a `fold_*_from_manager` directly — so a new mutation cannot land without a
/// fold, and nobody reintroduces a hand-wired one.
#[test]
fn every_command_is_classified_and_folds_only_through_commit() {
    let source = include_str!("connection.rs");
    let production = source.split("#[cfg(test)]").next().unwrap();

    let direct = production.matches("_from_manager(").count();
    assert_eq!(
        direct, 3,
        "only `Fold::apply` may call a `fold_*_from_manager` (one per region)"
    );

    let mutating: Vec<&str> = mutating_commands().iter().map(|(n, _, _)| *n).collect();
    for (name, body) in command_bodies(production) {
        if READ_ONLY_COMMANDS.contains(&name.as_str()) {
            assert!(
                !body.contains("commit(&app"),
                "{name} is listed read-only but folds"
            );
            continue;
        }
        assert!(
            mutating.contains(&name.as_str()),
            "new command `{name}`: list it in `mutating_commands` (with its folds) \
             or in `READ_ONLY_COMMANDS`"
        );
        assert!(
            body.contains("commit(&app"),
            "{name} mutates the manager but does not go through `commit`"
        );
    }
}
