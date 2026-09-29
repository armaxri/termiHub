//! Runtime wire-contract golden fixtures (audit MOCK-005, #3837).
//!
//! The ts-rs bindings in `src/types/generated/` pin the *static* shape of every
//! IPC DTO, so a renamed Rust field breaks `tsc`. They cannot see a change that
//! only moves the *serialized* JSON: a `skip_serializing_if` that turns `null`
//! into an absent key, a serde `rename` of an enum variant, a flattened map that
//! starts or stops spilling keys, or a mirror type whose `Deserialize`-side shape
//! drifts from the type that actually serializes (the `transfer_list` DTO is a
//! live example: ts-rs types it from the `transfers_projection` mirror while the
//! command returns core's registry snapshot).
//!
//! This test serializes representative, edge-case-rich instances of the key IPC
//! DTOs — through the exact types the Tauri commands return — into committed
//! JSON fixtures under `src/test/fixtures/wire/`. The frontend wire-contract
//! suite (`src/services/wireContract.test.ts`) feeds those fixtures to the real
//! `src/services` wrappers as the `invoke` responses and asserts what the
//! wrappers (and the helpers that consume their output) produce. So a serde-only
//! backend change regenerates a fixture, and the frontend assertions fail.
//!
//! Like the ts-rs `export_bindings_*` tests, this test *writes* the fixtures;
//! the `code-quality` CI job re-runs it and fails when the tree changed, i.e.
//! when a serde change landed without the refreshed fixture. Regenerate with:
//!
//! ```text
//! cargo test -p termihub --lib ipc_wire_fixtures
//! ```

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};

use crate::commands::connection::{ConnectionData, ExternalFileError};
use crate::connection::config::{ConnectionFolder, SavedConnection, SavedRemoteAgent};
use crate::connection::settings::AppSettings;
use crate::projection::{compute_ops, DiffFrame, DiffKind, ProjectionFrame, SnapshotFrame};
use crate::terminal::agent_manager::{AgentCapabilities, AgentConnectResult, AgentDefinitionInfo};
use crate::workspace::config::WorkspaceDefinition;
use termihub_core::files::transfer::progress::TransferDirection;
use termihub_core::files::transfer::registry::TransferSnapshot;
use termihub_core::files::transfer::state::TransferStateTag;
use termihub_core::network::{OpenPort, Protocol};

/// Directory (relative to the repo root) the fixtures are written to.
const FIXTURE_DIR: &str = "src/test/fixtures/wire";

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(FIXTURE_DIR)
}

/// Serialize `value` exactly as a Tauri command return value is serialized
/// (`serde_json`), panicking with the case name on failure.
fn wire<T: Serialize>(name: &str, value: &T) -> Value {
    serde_json::to_value(value).unwrap_or_else(|e| panic!("{name}: serialize failed: {e}"))
}

/// Decode a JSON literal into a backend DTO — the way the backend receives it
/// from disk or the agent — so the fixture input stays readable and robust to
/// fields gaining serde defaults. Only the *serialized* output is under test.
fn from_json<T: serde::de::DeserializeOwned>(name: &str, value: Value) -> T {
    serde_json::from_value(value).unwrap_or_else(|e| panic!("{name}: decode failed: {e}"))
}

/// Write one fixture file (pretty JSON + trailing newline), only when changed.
fn write_fixture(file: &str, cases: Value) {
    let dir = fixture_dir();
    std::fs::create_dir_all(&dir).expect("create fixture dir");
    let path = dir.join(file);
    let mut body = serde_json::to_string_pretty(&cases).expect("pretty-print fixture");
    body.push('\n');
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current != body {
        std::fs::write(&path, body).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
    }
}

// ── connections / folders (`load_connections_and_folders`) ───────────────────

fn connections_fixture() -> Value {
    // A fully-populated connection: terminal options with an unmodelled key that
    // rides the `#[serde(flatten)] extra` catch-all, an icon, an external source
    // file, and the legacy `resilientReconnect` settings key that the
    // `settings_bag` codec rewrites to `autoReconnect` on the way in.
    let full: SavedConnection = from_json(
        "full connection",
        json!({
            "id": "Work/Build Box",
            "name": "Build Box",
            "config": {
                "type": "ssh",
                "config": {
                    "host": "build.example.com",
                    "port": 2222,
                    "username": "ci",
                    "authMethod": "key",
                    "keyPath": "~/.ssh/id_ed25519",
                    "resilientReconnect": true
                }
            },
            "folderId": "Work",
            "terminalOptions": {
                "fontFamily": "Hack",
                "fontSize": 14,
                "lineHeight": 1.25,
                "cursorStyle": "bar",
                "lineEnding": "crlf",
                "futureTerminalOption": { "nested": [1, 2] }
            },
            "icon": "server",
            "sourceFile": "/home/me/shared/team.json"
        }),
    );
    // A bare root-level connection: every optional key absent, `folderId` null.
    let bare: SavedConnection = from_json(
        "bare connection",
        json!({
            "id": "Scratch",
            "name": "Scratch",
            "config": { "type": "local", "config": {} },
            "folderId": null
        }),
    );
    let agent: SavedRemoteAgent = from_json(
        "agent",
        json!({
            "id": "agent-pi",
            "name": "Pi",
            "config": { "host": "pi.local", "port": 22, "username": "pi" }
        }),
    );
    let data = ConnectionData {
        connections: vec![full, bare],
        folders: vec![
            ConnectionFolder {
                id: "Work".into(),
                name: "Work".into(),
                parent_id: None,
                is_expanded: true,
            },
            ConnectionFolder {
                id: "Work/Dev".into(),
                name: "Dev".into(),
                parent_id: Some("Work".into()),
                is_expanded: false,
            },
        ],
        agents: vec![agent],
        external_errors: vec![ExternalFileError {
            file_path: "/home/me/broken.json".into(),
            error: "expected value at line 1 column 1".into(),
        }],
    };
    json!({ "loadConnectionsAndFolders": wire("ConnectionData", &data) })
}

// ── session create (`create_connection`) ──────────────────────────────────────

fn session_fixture() -> Value {
    // `create_connection` returns the new session id as a bare JSON string.
    let session_id: String = "3f2b8c1e-5a4d-4e7b-9c0a-1d2e3f4a5b6c".into();
    json!({ "createConnection": wire("session id", &session_id) })
}

// ── agent connect / definitions ───────────────────────────────────────────────

fn agent_fixture() -> Value {
    // An older agent: it omits every `#[serde(default)]` capability, which the
    // backend nonetheless re-serializes explicitly (empty list / false / "").
    let legacy_caps: AgentCapabilities = from_json(
        "legacy capabilities",
        json!({ "connectionTypes": [], "maxSessions": 4 }),
    );
    let caps: AgentCapabilities = from_json(
        "capabilities",
        json!({
            "connectionTypes": [{
                "typeId": "local",
                "displayName": "Local Shell",
                "icon": "terminal",
                "schema": { "groups": [] },
                "capabilities": {
                    "monitoring": true,
                    "fileBrowser": true,
                    "resize": true,
                    "persistent": true
                }
            }],
            "maxSessions": 16,
            "availableShells": ["/bin/bash", "/bin/zsh"],
            "availableSerialPorts": ["/dev/ttyUSB0"],
            "dockerAvailable": true,
            "availableDockerImages": ["alpine:3.20"],
            "monitoringSupported": true,
            "toolStreaming": true,
            "embeddedServerActivity": false,
            "agentVersion": "1.4.2"
        }),
    );
    let connect = AgentConnectResult {
        capabilities: caps,
        agent_version: "1.4.2".into(),
        protocol_version: "0.9.0".into(),
    };
    let legacy_connect = AgentConnectResult {
        capabilities: legacy_caps,
        agent_version: "0.3.0".into(),
        protocol_version: "0.1.0".into(),
    };
    let definitions = vec![
        AgentDefinitionInfo {
            id: "def-1".into(),
            name: "Serial console".into(),
            session_type: "serial".into(),
            config: json!({ "port": "/dev/ttyUSB0", "baudRate": 115200, "dataBits": 8 }),
            persistent: true,
            folder_id: Some("folder-lab".into()),
            terminal_options: Some(json!({ "fontSize": 12, "cursorBlink": false })),
            icon: Some("cpu".into()),
            source_file: Some("/etc/termihub/shared.json".into()),
        },
        AgentDefinitionInfo {
            id: "def-2".into(),
            name: "Shell".into(),
            session_type: "local".into(),
            config: json!({}),
            persistent: false,
            folder_id: None,
            terminal_options: None,
            icon: None,
            source_file: None,
        },
    ];
    json!({
        "connectAgent": wire("AgentConnectResult", &connect),
        "connectAgentLegacy": wire("AgentConnectResult (legacy)", &legacy_connect),
        "listAgentDefinitions": wire("AgentDefinitionInfo[]", &definitions),
    })
}

// ── settings (`get_settings`) ─────────────────────────────────────────────────

fn settings_fixture() -> Value {
    // Every unset `Option` field is skipped, the `default_true` flags are always
    // emitted, lenient enums serialize as their string form, and an unknown
    // top-level key round-trips through the `#[serde(flatten)] extra` catch-all.
    let settings: AppSettings = from_json(
        "AppSettings",
        json!({
            "version": "2",
            "externalConnectionFiles": [{ "path": "/home/me/team.json", "enabled": false }],
            "theme": "custom:midnight",
            "fontSize": 13,
            "lineHeight": 1.5,
            "cursorStyle": "underline",
            "restoreLastSessionMode": "always",
            "defaultLineEnding": "crlf",
            "credentialAutoLockMinutes": 0,
            "powerMonitoringEnabled": false,
            "fileLanguageMappings": { "*.conf": "ini" },
            "futureSettingFromNewerBuild": { "enabled": true }
        }),
    );
    json!({ "getSettings": wire("AppSettings", &settings) })
}

// ── workspace load (`load_workspace`) ─────────────────────────────────────────

fn workspace_fixture() -> Value {
    // A nested split (internally-tagged union) holding a leaf with a
    // saved-connection ref, an inline config and an agent ref; a second group
    // is a bare leaf with no optional keys.
    let definition: WorkspaceDefinition = from_json(
        "WorkspaceDefinition",
        json!({
            "id": "ws-1",
            "name": "Release day",
            "description": "Build + deploy",
            "tabGroups": [
                {
                    "name": "Main",
                    "color": "#ff8800",
                    "layout": {
                        "type": "split",
                        "direction": "horizontal",
                        "sizes": [60.0, 40.0],
                        "children": [
                            { "type": "leaf", "tabs": [
                                { "connectionRef": "Work/Build Box", "title": "build",
                                  "initialCommand": "make release" },
                                { "inlineConfig": { "type": "local", "config": { "shell": "zsh" } } }
                            ] },
                            { "type": "split", "direction": "vertical", "children": [
                                { "type": "leaf", "tabs": [
                                    { "agentRef": { "agentId": "agent-pi", "definitionId": "def-1" } }
                                ] },
                                { "type": "leaf", "tabs": [] }
                            ] }
                        ]
                    }
                },
                { "name": "Scratch", "layout": { "type": "leaf", "tabs": [
                    { "connectionRef": "Scratch" }
                ] } }
            ]
        }),
    );
    json!({ "loadWorkspace": wire("WorkspaceDefinition", &definition) })
}

// ── transfer snapshot (`transfer_list`) ───────────────────────────────────────

fn transfer_fixture(drift: &mut Vec<String>) -> Value {
    // The command returns core's registry snapshot (not the ts-rs-typed
    // `transfers_projection` mirror), so that is what is serialized here.
    let snapshots = vec![
        TransferSnapshot {
            transfer_id: "tx-1".into(),
            session_id: "sess-1".into(),
            direction: TransferDirection::Download,
            file_name: "disk.img".into(),
            path: "/var/tmp/disk.img".into(),
            state: TransferStateTag::Active,
            settled: false,
            // > 2^32: a u64 byte count must survive as an exact JS number.
            transferred: 4_294_967_296 + 17,
            total: 6_442_450_944,
            speed: 12_582_912,
            attempt: 2,
            max_attempts: 5,
        },
        TransferSnapshot {
            transfer_id: "tx-2".into(),
            session_id: "sess-1".into(),
            direction: TransferDirection::Upload,
            file_name: "notes.txt".into(),
            // Empty path is skipped on the wire (`skip_serializing_if`).
            path: String::new(),
            state: TransferStateTag::Cancelled,
            settled: true,
            transferred: 0,
            total: 0,
            speed: 0,
            attempt: 1,
            max_attempts: 3,
        },
    ];
    let wire_value = wire("TransferSnapshot[]", &snapshots);
    // The generated TS type comes from the `transfers_projection` mirror; check
    // the producer's JSON decodes into it, so the two Rust sides cannot drift.
    // Reported after every fixture is written, so the frontend suite sees the
    // drifted wire shape too.
    if let Err(e) = serde_json::from_value::<
        Vec<crate::transfers_projection::store::TransferSnapshot>,
    >(wire_value.clone())
    {
        drift.push(format!(
            "transfer_list JSON does not decode into the ts-rs mirror: {e}"
        ));
    }
    json!({ "transferList": wire_value })
}

// ── open ports (`network_open_ports`) ─────────────────────────────────────────

fn open_ports_fixture() -> Value {
    // The owning pid / process are unknown for some sockets: `None` is `null`
    // (not absent) on the wire.
    let ports = vec![
        OpenPort {
            protocol: Protocol::Tcp,
            local_addr: "127.0.0.1:5432".into(),
            pid: Some(4242),
            process: Some("postgres".into()),
        },
        OpenPort {
            protocol: Protocol::Udp,
            local_addr: "[::]:5353".into(),
            pid: None,
            process: None,
        },
    ];
    json!({ "networkOpenPorts": wire("OpenPort[]", &ports) })
}

// ── projection snapshot / diff frames (`projection_subscribe` + channel) ──────

fn projection_fixture() -> Value {
    // Keys with `/` and `~` exercise RFC 6901 pointer escaping; the diff is
    // computed by the real backend differ, so the frontend applier is checked
    // against exactly what the backend emits.
    let before = json!({
        "items": [{ "id": "a", "label": "Alpha" }, { "id": "b", "label": "Beta" }],
        "byPath": { "Work/Dev": { "open": false }, "tilde~key": 1 },
        "selected": null,
        "count": 2
    });
    let after = json!({
        "items": [{ "id": "a", "label": "Alpha!" }],
        "byPath": { "Work/Dev": { "open": true }, "new/key": [] },
        "selected": "a",
        "count": 1
    });
    let snapshot = SnapshotFrame {
        kind: Default::default(),
        region: "wire-contract".into(),
        version: 7,
        view: before,
    };
    let diff = DiffFrame {
        kind: DiffKind::Diff,
        region: "wire-contract".into(),
        base_version: 7,
        version: 8,
        ops: compute_ops(&snapshot.view, &after),
    };
    let mut applied = snapshot.view.clone();
    crate::projection::apply_ops(&mut applied, &diff.ops).expect("backend applies its own diff");
    assert_eq!(applied, after, "backend differ round-trips");
    let resync_current: Option<SnapshotFrame> = None;
    json!({
        "subscribeSnapshot": wire("SnapshotFrame", &snapshot),
        "channelDiff": wire("ProjectionFrame::Diff", &ProjectionFrame::Diff(diff)),
        "resyncCurrent": wire("Option<SnapshotFrame>", &resync_current),
        "expectedView": after,
    })
}

#[test]
fn write_ipc_wire_fixtures() {
    write_fixture("connections.json", connections_fixture());
    write_fixture("session.json", session_fixture());
    write_fixture("agent.json", agent_fixture());
    write_fixture("settings.json", settings_fixture());
    write_fixture("workspace.json", workspace_fixture());
    let mut drift = Vec::new();
    write_fixture("transfers.json", transfer_fixture(&mut drift));
    write_fixture("open_ports.json", open_ports_fixture());
    write_fixture("projection.json", projection_fixture());
    assert!(drift.is_empty(), "wire drift: {drift:#?}");
}
