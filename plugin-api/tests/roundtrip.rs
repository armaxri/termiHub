//! End-to-end round-trip tests exercising the ABI types the way the host and a
//! plugin would across the boundary — but within one process, so no real dylib
//! is needed. The host loader lives in a separate crate/issue; these tests cover
//! only the contract this crate defines.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use termihub_plugin_api::{
    FfiString, LoadedBackend, PluginBackend, PluginError, PluginInfo, PluginOutputSender,
    PluginSessionConfig, PluginStatus, PluginTerminalBackend, CURRENT_PLUGIN_API_VERSION,
};

/// A backend whose behavior each test can steer.
struct TestBackend {
    output: PluginOutputSender,
    alive: AtomicBool,
    panic_on_input: bool,
}

impl PluginTerminalBackend for TestBackend {
    fn write_input(&self, data: &[u8]) -> Result<(), PluginError> {
        assert!(!self.panic_on_input, "boom");
        self.output.send(data)
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), PluginError> {
        Ok(())
    }
    fn close(&self) -> Result<(), PluginError> {
        self.alive.store(false, Ordering::SeqCst);
        Ok(())
    }
    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

fn make_backend(panic_on_input: bool) -> (LoadedBackend, mpsc::Receiver<Vec<u8>>) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let backend = PluginBackend::from_boxed(Box::new(TestBackend {
        output: PluginOutputSender::from_sender(tx),
        alive: AtomicBool::new(true),
        panic_on_input,
    }));
    // SAFETY: `backend` was just produced by `from_boxed`, so it is valid.
    let loaded = unsafe { LoadedBackend::from_raw(backend) };
    (loaded, rx)
}

#[test]
fn input_flows_to_output_channel() {
    let (backend, rx) = make_backend(false);
    assert!(backend.is_alive());
    backend.write_input(b"echo me").unwrap();
    assert_eq!(rx.recv().unwrap(), b"echo me".to_vec());
    backend.resize(120, 40).unwrap();
    backend.close().unwrap();
    assert!(!backend.is_alive());
}

#[test]
fn dropped_receiver_reports_channel_closed() {
    let (backend, rx) = make_backend(false);
    drop(rx);
    let err = backend.write_input(b"nowhere").unwrap_err();
    assert!(matches!(err, PluginError::ChannelClosed));
}

#[test]
fn plugin_panic_is_contained_as_status() {
    // A panic inside the backend must not unwind across the (simulated) FFI
    // boundary; the wrapper reports it as an error instead of aborting.
    let (backend, _rx) = make_backend(true);
    let err = backend.write_input(b"trigger").unwrap_err();
    assert!(matches!(err, PluginError::Panicked));
}

#[test]
fn backend_destroyed_on_drop_without_leak() {
    // Track construction/destruction via a shared flag in the closure-owned box.
    static DROPPED: AtomicBool = AtomicBool::new(false);
    struct DropSpy;
    impl PluginTerminalBackend for DropSpy {
        fn write_input(&self, _: &[u8]) -> Result<(), PluginError> {
            Ok(())
        }
        fn resize(&self, _: u16, _: u16) -> Result<(), PluginError> {
            Ok(())
        }
        fn close(&self) -> Result<(), PluginError> {
            Ok(())
        }
        fn is_alive(&self) -> bool {
            true
        }
    }
    impl Drop for DropSpy {
        fn drop(&mut self) {
            DROPPED.store(true, Ordering::SeqCst);
        }
    }

    let raw = PluginBackend::from_boxed(Box::new(DropSpy));
    // SAFETY: freshly produced by `from_boxed`.
    let backend = unsafe { LoadedBackend::from_raw(raw) };
    assert!(!DROPPED.load(Ordering::SeqCst));
    drop(backend);
    assert!(
        DROPPED.load(Ordering::SeqCst),
        "backend must be freed on drop"
    );
}

#[test]
fn plugin_info_owns_and_frees_its_strings() {
    // Host allocates an empty slot; "plugin" fills it; host reads then drops.
    let mut info = PluginInfo::empty();
    assert_eq!(info.id.as_str(), "");
    info = PluginInfo::new(
        "k8s-exec",
        "Kubernetes Exec",
        "1.2.0",
        CURRENT_PLUGIN_API_VERSION,
    );
    assert_eq!(info.id.as_str(), "k8s-exec");
    assert_eq!(info.name.as_str(), "Kubernetes Exec");
    assert_eq!(info.version.as_str(), "1.2.0");
    assert_eq!(info.api_version, CURRENT_PLUGIN_API_VERSION);
    drop(info); // must not leak or double-free the embedded FfiStrings
}

#[test]
fn session_config_borrows_json() {
    let json = r#"{"pod":"nginx","namespace":"default"}"#.to_owned();
    let config = PluginSessionConfig::new(&json);
    // SAFETY: `json` outlives this borrow.
    let seen = unsafe { config.config_json.as_str() };
    assert_eq!(seen, json);
}

#[test]
fn ffi_string_round_trips() {
    let s = FfiString::from_string("héllo".to_owned());
    assert_eq!(s.as_str(), "héllo");
    assert_eq!(s.as_bytes(), "héllo".as_bytes());
    let empty = FfiString::empty();
    assert_eq!(empty.as_str(), "");
}

#[test]
fn status_error_mapping_is_consistent() {
    assert!(PluginStatus::from_result(Ok(())).is_ok());
    assert_eq!(
        PluginStatus::from_error(&PluginError::ChannelClosed),
        PluginStatus::ChannelClosed,
    );
    assert!(matches!(
        PluginStatus::ChannelClosed.into_result(),
        Err(PluginError::ChannelClosed),
    ));
    assert!(PluginStatus::Ok.into_result().is_ok());
}
