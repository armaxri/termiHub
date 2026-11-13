//! The X11 forwarding mode (#5586) and its reason (#5601): the manager
//! records the backend's mode and reason on the session info the Open
//! Connections panel lists.

use super::*;
use termihub_core::connection::{X11ForwardingMode, X11ForwardingReason};

/// A connection reporting a fixed X11 forwarding mode once connected.
struct X11Connection {
    mode: Option<X11ForwardingMode>,
    reason: Option<X11ForwardingReason>,
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
    fn x11_forwarding_reason(&self) -> Option<X11ForwardingReason> {
        self.reason
    }
}

async fn listed_mode(mode: Option<X11ForwardingMode>) -> Option<X11ForwardingMode> {
    listed(mode, None).await.0
}

/// The mode and reason the manager lists for a backend reporting them.
async fn listed(
    mode: Option<X11ForwardingMode>,
    reason: Option<X11ForwardingReason>,
) -> (Option<X11ForwardingMode>, Option<X11ForwardingReason>) {
    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        "x11-mock",
        "X11 Mock",
        "mock",
        Box::new(move || {
            Box::new(X11Connection {
                mode,
                reason,
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
    (info.x11_forwarding, info.x11_forwarding_reason)
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
        x11_forwarding_reason: None,
    };
    let json = serde_json::to_value(&info).unwrap();
    assert!(json.get("x11Forwarding").is_none(), "{json}");
    assert!(json.get("x11ForwardingReason").is_none(), "{json}");
    let info = SessionInfo {
        x11_forwarding: Some(X11ForwardingMode::FallbackRefused),
        ..info
    };
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["x11Forwarding"], "fallbackRefused");
}

#[tokio::test]
async fn the_backend_x11_reason_is_listed_on_the_session() {
    use X11ForwardingReason as R;
    for (mode, reason) in [
        (X11ForwardingMode::Failed, R::NoLocalXServer),
        (X11ForwardingMode::FallbackRefused, R::ServerRefused),
        (X11ForwardingMode::FallbackNoReply, R::ServerNoReply),
        (X11ForwardingMode::Failed, R::UntrustedNoSecurityExtension),
        (X11ForwardingMode::Failed, R::UntrustedXauthMissing),
        (X11ForwardingMode::Failed, R::UntrustedXauthFailed),
        (X11ForwardingMode::Failed, R::FallbackFailed),
    ] {
        assert_eq!(
            listed(Some(mode), Some(reason)).await,
            (Some(mode), Some(reason))
        );
    }
}

#[tokio::test]
async fn a_server_forwarded_session_lists_no_reason() {
    assert_eq!(
        listed(Some(X11ForwardingMode::ServerForwarded), None).await,
        (Some(X11ForwardingMode::ServerForwarded), None)
    );
}

#[test]
fn the_reason_serializes_next_to_the_mode() {
    let info = SessionInfo {
        id: "s".into(),
        title: "t".into(),
        connection_type: "ssh".into(),
        alive: true,
        agent_id: None,
        spawned: false,
        x11_forwarding: Some(X11ForwardingMode::Failed),
        x11_forwarding_reason: Some(X11ForwardingReason::UntrustedNoSecurityExtension),
    };
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["x11Forwarding"], "failed");
    assert_eq!(json["x11ForwardingReason"], "untrustedNoSecurityExtension");
}
