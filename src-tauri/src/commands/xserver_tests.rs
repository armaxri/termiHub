//! Command-layer tests for the X server IPC (#5168): the progress events a
//! command's success / failure tail emits, the stop no-op, and the consent
//! reply routing — on `tauri::test::mock_app()`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::test::{mock_app, MockRuntime};
use tauri::{App, Listener, Manager};

use super::*;
use crate::terminal::xserver::auth::{XAuth, XAuthProvider};
use crate::terminal::xserver::manager::{ManagedProcess, PortProbe, XServerLauncher};
use crate::terminal::xserver::{XServerState, X_SERVER_PROGRESS_EVENT};

struct ClosedProbe;
impl PortProbe for ClosedProbe {
    fn is_open(&self, _port: u16) -> bool {
        false
    }
}

struct NoLaunch;
impl XServerLauncher for NoLaunch {
    fn launch(
        &self,
        _exe: &Path,
        _display: u32,
        _auth_file: Option<&Path>,
    ) -> anyhow::Result<Box<dyn ManagedProcess>> {
        anyhow::bail!("launch must not be reached")
    }
}

struct NoAuth;
impl XAuthProvider for NoAuth {
    fn provision(&self, _display: u32) -> anyhow::Result<XAuth> {
        anyhow::bail!("auth must not be reached")
    }
}

/// A mock app with a stopped manager, recording every progress event.
fn app_with_progress() -> (App<MockRuntime>, Arc<Mutex<Vec<Value>>>) {
    let app = mock_app();
    app.manage(Arc::new(XServerManager::new(
        Box::new(ClosedProbe),
        Box::new(NoLaunch),
        Box::new(|| Ok(PathBuf::from("vcxsrv.exe"))),
        Box::new(NoAuth),
        false,
        false,
    )));
    app.manage(Arc::new(ConnectConsentRegistry::new()));
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    app.listen_any(X_SERVER_PROGRESS_EVENT, move |e| {
        sink.lock()
            .unwrap()
            .push(serde_json::from_str(e.payload()).unwrap());
    });
    (app, events)
}

#[test]
fn finish_reports_success_with_the_ok_message() {
    let (app, events) = app_with_progress();
    assert!(finish(app.handle(), Ok(()), "XQuartz is ready.").is_ok());
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["step"], "ready");
    assert_eq!(events[0]["message"], "XQuartz is ready.");
    assert_eq!(events[0]["progress"], 1.0);
}

#[test]
fn finish_reports_and_returns_the_typed_error() {
    let (app, events) = app_with_progress();
    let err = XServerError::linux_install_unsupported();
    let expected = err.to_string();

    let result = finish(app.handle(), Err(err), "unused");

    assert_eq!(result.unwrap_err().to_string(), expected);
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["step"], "failed");
    assert_eq!(events[0]["message"], expected.as_str());
}

#[test]
fn stopping_a_server_that_is_not_running_is_a_silent_no_op() {
    let (app, events) = app_with_progress();
    let manager = app.state::<Arc<XServerManager>>();
    assert!(x_server_stop(app.handle().clone(), manager).is_ok());
    assert!(
        events.lock().unwrap().is_empty(),
        "nothing stopped, no event"
    );
}

#[test]
fn status_of_a_stopped_manager_is_reported_without_side_effects() {
    let (app, events) = app_with_progress();
    let report = x_server_status(app.state::<Arc<XServerManager>>());
    // A stopped manager never reports a managed server; a host X server the
    // detection finds (an Xvfb on a CI runner) is reported as adopted.
    assert!(
        matches!(report.state, XServerState::Absent | XServerState::Adopted),
        "{:?}",
        report.state
    );
    assert!(!report.managed);
    assert!(events.lock().unwrap().is_empty());
}

#[test]
fn a_consent_reply_wakes_only_its_pending_connect_once() {
    let (app, _) = app_with_progress();
    let registry = app.state::<Arc<ConnectConsentRegistry>>();
    let (id, mut rx) = registry.register();

    assert!(!x_server_connect_consent_reply(
        "unknown".into(),
        ConsentDecision::Enable,
        app.state::<Arc<ConnectConsentRegistry>>()
    ));
    assert!(x_server_connect_consent_reply(
        id.clone(),
        ConsentDecision::NotNow,
        app.state::<Arc<ConnectConsentRegistry>>()
    ));
    assert_eq!(rx.try_recv().unwrap(), ConsentDecision::NotNow);
    // Already resolved: a second reply (another window) matches nothing.
    assert!(!x_server_connect_consent_reply(
        id,
        ConsentDecision::Enable,
        app.state::<Arc<ConnectConsentRegistry>>()
    ));
}
