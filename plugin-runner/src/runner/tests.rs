//! Teardown order of the session server (TBE2-004, #4341): every session's
//! backend is closed and destroyed **before** the plugin library's
//! `plugin_shutdown` runs and the library unmaps. A backend's vtable and state
//! point into the mapped library, so the reverse order is a use-after-free.
//!
//! These mirror the in-process host tests the sandbox cut-over removed
//! (`library_stays_mapped_until_the_last_arc_drops` and friends, #2968).

use std::cell::RefCell;
use std::sync::mpsc::channel;

use termihub_plugin_api::{PluginBackend, PluginTerminalBackend, CURRENT_PLUGIN_ABI_VERSION};
use termihub_plugin_runner::ipc::{Cancel, ResourceLimits};
use termihub_plugin_runner::loader::LoadedPluginInfo;

use super::*;

thread_local! {
    /// What happened, in order. Teardown runs every backend and library call
    /// on the calling thread, so a per-test-thread log keeps tests apart.
    static EVENTS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn record(event: String) {
    EVENTS.with(|events| events.borrow_mut().push(event));
}

fn events() -> Vec<String> {
    EVENTS.with(|events| events.borrow().clone())
}

unsafe extern "C" fn record_shutdown() {
    record("shutdown".to_owned());
}

/// A backend that records `close` and its own destruction (`destroy`).
struct Probe(u32);

impl PluginTerminalBackend for Probe {
    fn write_input(&self, _data: &[u8]) -> Result<(), PluginError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), PluginError> {
        Ok(())
    }
    fn close(&self) -> Result<(), PluginError> {
        record(format!("close:{}", self.0));
        Ok(())
    }
    fn is_alive(&self) -> bool {
        true
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        record(format!("destroy:{}", self.0));
    }
}

fn configure() -> Configure {
    Configure {
        library_path: String::new(),
        expected_digest: None,
        manifest_api_version: None,
        accept_unverified_toolchain: false,
        plugin_id: "probe".to_owned(),
        host_version: "0.0.0".to_owned(),
        limits: ResourceLimits::default(),
        sandbox: None,
        accept_reduced_isolation: false,
    }
}

/// A server around the stub library, with a session per id.
fn server_with(ids: &[u32]) -> Server {
    let info = LoadedPluginInfo {
        id: "probe".to_owned(),
        name: "Probe".to_owned(),
        version: "0.0.0".to_owned(),
        abi_version: CURRENT_PLUGIN_ABI_VERSION,
        toolchain: None,
    };
    let library = PluginLibrary::for_teardown_test(info, record_shutdown).unwrap();
    let channel = Arc::new(Channel::new(Box::new(std::io::sink())));
    #[cfg(unix)]
    let bridge = BridgeClient::new(Arc::clone(&channel), None);
    #[cfg(not(unix))]
    let bridge = BridgeClient::new(Arc::clone(&channel));
    let server = Server::new(library, configure(), Arc::clone(&channel), bridge);
    for &id in ids {
        // SAFETY: `from_boxed` produced the handle; ownership moves to the wrapper.
        let backend =
            unsafe { LoadedBackend::from_raw(PluginBackend::from_boxed(Box::new(Probe(id)))) };
        let session = Session {
            backend,
            output: SessionOutput::new(id, Arc::clone(&channel)),
            services: None,
            alive: true,
        };
        server.sessions.lock().unwrap().insert(id, session);
    }
    server
}

/// `shutdown` is the very last event and each session closed before it was
/// destroyed.
fn assert_sessions_end_before_the_library(log: &[String], ids: &[u32], closed: bool) {
    assert_eq!(log.last().map(String::as_str), Some("shutdown"), "{log:?}");
    assert_eq!(
        log.iter().filter(|e| *e == "shutdown").count(),
        1,
        "{log:?}"
    );
    for id in ids {
        let at = |event: String| log.iter().position(|e| *e == event);
        let destroy =
            at(format!("destroy:{id}")).unwrap_or_else(|| panic!("{id} destroyed: {log:?}"));
        if closed {
            let close = at(format!("close:{id}")).unwrap_or_else(|| panic!("{id} closed: {log:?}"));
            assert!(close < destroy, "{log:?}");
        }
    }
    let expected = 1 + ids.len() * if closed { 2 } else { 1 };
    assert_eq!(log.len(), expected, "{log:?}");
}

#[test]
fn teardown_closes_and_destroys_every_session_before_plugin_shutdown() {
    let server = server_with(&[1, 2, 3]);
    assert!(events().is_empty());
    server.teardown();
    assert_sessions_end_before_the_library(&events(), &[1, 2, 3], true);
}

#[test]
fn a_dropped_server_destroys_its_sessions_before_the_library() {
    // Even without `teardown` (an early return, a panic unwinding), the field
    // order alone must drop every backend before the library: `library` is
    // `Server`'s last field.
    let server = server_with(&[7, 8]);
    drop(server);
    assert_sessions_end_before_the_library(&events(), &[7, 8], false);
}

#[test]
fn serve_tears_down_in_order_on_shutdown() {
    let server = server_with(&[4, 5]);
    let (tx, rx) = channel();
    tx.send(Inbound::Message(Message::Close(SessionRef {
        session_id: 4,
    })))
    .unwrap();
    tx.send(Inbound::Message(Message::Cancel(Cancel {
        session_id: None,
    })))
    .unwrap();
    tx.send(Inbound::Message(Message::Shutdown)).unwrap();
    assert_eq!(server.serve(&rx), exit::OK);
    let log = events();
    // The explicit `Close` ended session 4 first; teardown then ended 5.
    assert_eq!(&log[..2], ["close:4", "destroy:4"], "{log:?}");
    assert_sessions_end_before_the_library(&log, &[4, 5], true);
}

#[test]
fn serve_reports_a_protocol_violation_and_still_tears_down_in_order() {
    let server = server_with(&[6]);
    let (tx, rx) = channel();
    tx.send(Inbound::Violation).unwrap();
    assert_eq!(server.serve(&rx), exit::PROTOCOL);
    assert_sessions_end_before_the_library(&events(), &[6], true);
}

#[test]
fn the_host_closing_the_channel_is_a_clean_exit() {
    let server = server_with(&[]);
    let (tx, rx) = channel::<Inbound>();
    drop(tx);
    assert_eq!(server.serve(&rx), exit::OK);
    assert_eq!(events(), ["shutdown"]);
}
