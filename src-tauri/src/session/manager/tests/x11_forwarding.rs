//! The X11 forwarding mode (#5586): the manager records the backend's mode on
//! the session info the Open Connections panel lists.

use super::*;
use termihub_core::connection::X11ForwardingMode;

/// A connection reporting a fixed X11 forwarding mode once connected.
struct X11Connection {
    mode: Option<X11ForwardingMode>,
    output: std::sync::Mutex<Option<tokio::sync::mpsc::Sender<Vec<u8>>>>,
}

#[async_trait::async_trait]
impl ConnectionType for X11Connection {
    fn type_id(&self) -> &str {
        "x11-mock"
    }
    fn display_name(&self) -> &str {
        "X11 Mock"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: true,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        *self.output.lock().unwrap() = Some(tx);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
    fn x11_forwarding(&self) -> Option<X11ForwardingMode> {
        self.mode
    }
}

async fn listed_mode(mode: Option<X11ForwardingMode>) -> Option<X11ForwardingMode> {
    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        "x11-mock",
        "X11 Mock",
        "mock",
        Box::new(move || {
            Box::new(X11Connection {
                mode,
                output: std::sync::Mutex::new(None),
            })
        }),
    );
    let manager = SessionManager::new(registry, Arc::new(FakeAgent::offline()));
    let session_id = manager
        .create_connection(
            "x11-mock",
            serde_json::json!({}),
            None,
            Some("tab-x11:0"),
            false,
            true,
            MockEventEmitter::default(),
        )
        .await
        .expect("session should open");
    let sessions = manager.list_sessions().await;
    let info = sessions
        .iter()
        .find(|s| s.id == session_id)
        .expect("session listed");
    info.x11_forwarding
}

#[tokio::test]
async fn the_backend_x11_mode_is_listed_on_the_session() {
    for mode in [
        X11ForwardingMode::ServerForwarded,
        X11ForwardingMode::FallbackRefused,
        X11ForwardingMode::FallbackNoReply,
        X11ForwardingMode::Failed,
    ] {
        assert_eq!(listed_mode(Some(mode)).await, Some(mode));
    }
}

#[tokio::test]
async fn a_session_without_x11_lists_no_mode_and_serializes_without_it() {
    assert_eq!(listed_mode(None).await, None);
    let info = SessionInfo {
        id: "s".into(),
        title: "t".into(),
        connection_type: "ssh".into(),
        alive: true,
        agent_id: None,
        spawned: false,
        x11_forwarding: None,
    };
    let json = serde_json::to_value(&info).unwrap();
    assert!(json.get("x11Forwarding").is_none(), "{json}");
    let info = SessionInfo {
        x11_forwarding: Some(X11ForwardingMode::FallbackRefused),
        ..info
    };
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["x11Forwarding"], "fallbackRefused");
}
