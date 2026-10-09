//! Plugin connect / disconnect run off the async runtime's worker threads and
//! honour the connect cancel token (#4323, audit finding CORE2-001).
//!
//! A plugin's `create_backend` runs in its sandboxed runner (ADR-19) and may
//! take seconds (it connects to its device); the host waits for the answer.
//! These tests drive the native test-plugin fixture with its `stallCreateMs`
//! knob through the real `termihub-plugin-runner` on a **current-thread**
//! runtime, where a connect that blocked the worker would stall every other
//! task outright.
#![cfg(feature = "plugin")]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod plugin_fixture;
mod plugin_runner_support;
use plugin_fixture::{fixture_library, Variant};
use plugin_runner_support::{install_plugin, new_connection, runner_binary, InstalledEcho};

use termihub_core::connection::{ConnectionType, ConnectionTypeRegistry};
use termihub_core::plugin::sandbox::{PluginRunnerConfig, SandboxedPluginHandle};
use termihub_core::plugin::PluginHost;
use tokio_util::sync::CancellationToken;

const WAIT: Duration = Duration::from_secs(10);
/// How long the stalled plugin holds its `create_backend`.
const STALL_MS: u64 = 2_000;
/// The bound on anything that must happen "promptly" while the plugin stalls:
/// well under [`STALL_MS`], with slack for a loaded CI runner.
const PROMPT: Duration = Duration::from_millis(1_000);

const MANIFEST: &str = r#"{
    "id": "connect-fixture",
    "name": "Connect Fixture",
    "version": "0.1.0",
    "author": "termiHub tests",
    "description": "Echo fixture with a stallable connect (#4323)",
    "license": "MIT",
    "apiVersion": "1.1",
    "platforms": ["windows", "linux", "macos"],
    "permissions": ["terminal"],
    "extensions": {
        "terminalBackend": {
            "connectionType": "connect-fixture",
            "displayName": "Connect Fixture",
            "configSchema": { "type": "object", "properties": {} }
        }
    }
}"#;

/// The fixture plugin, installed and loaded out of process.
struct Fixture {
    _work: tempfile::TempDir,
    plugin: InstalledEcho,
    host: PluginHost,
    registry: Arc<Mutex<ConnectionTypeRegistry>>,
}

impl Fixture {
    fn new() -> Self {
        let work = tempfile::TempDir::new().unwrap();
        let lib = fixture_library(Variant::Default, work.path());
        let plugin = install_plugin(work.path(), &lib, MANIFEST);
        let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
        let host = PluginHost::new(&plugin.root, Arc::clone(&registry))
            .with_runner(PluginRunnerConfig::new(runner_binary()));
        host.load(&plugin.plugin).expect("the fixture loads");
        Self {
            _work: work,
            plugin,
            host,
            registry,
        }
    }

    fn connection(&self) -> Box<dyn ConnectionType> {
        new_connection(&self.registry, &self.plugin.type_id)
    }

    fn handle(&self) -> Arc<SandboxedPluginHandle> {
        self.host
            .sandboxed_plugin(&self.plugin.plugin.manifest.id)
            .expect("loaded out of process")
    }

    /// Sessions the running runner still holds for this host.
    fn sessions(&self) -> usize {
        self.handle()
            .running()
            .map_or(0, |runner| runner.session_count())
    }
}

fn current_thread() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn stalled() -> serde_json::Value {
    serde_json::json!({ "stallCreateMs": STALL_MS })
}

/// Poll `cond` on the runtime (never blocking its one thread).
async fn eventually(mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    cond()
}

/// Write `text` and read the echo back.
async fn assert_echoes(
    conn: &dyn ConnectionType,
    rx: &mut termihub_core::connection::OutputReceiver,
    text: &str,
) {
    conn.write(text.as_bytes()).expect("input is queued");
    let chunk = tokio::time::timeout(WAIT, rx.recv())
        .await
        .expect("echo within the timeout")
        .expect("an output chunk");
    assert_eq!(String::from_utf8(chunk).unwrap(), text);
}

#[test]
fn a_stalled_plugin_connect_does_not_block_the_runtime() {
    let fixture = Fixture::new();
    current_thread().block_on(async {
        let mut conn = fixture.connection();
        let mut rx = conn.subscribe_output();
        let connect = tokio::spawn(async move {
            let result = conn.connect(stalled()).await;
            (conn, result)
        });

        // While the plugin holds its connect, an unrelated timer on the same
        // (single-threaded) runtime still fires on time.
        let started = Instant::now();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let slept = started.elapsed();
        assert!(
            slept < PROMPT,
            "a 100 ms sleep took {slept:?}: the plugin connect blocked the runtime"
        );
        assert!(!connect.is_finished(), "the plugin is still connecting");

        // The connect itself still completes normally.
        let (conn, result) = tokio::time::timeout(WAIT, connect)
            .await
            .expect("the connect finishes")
            .unwrap();
        result.expect("the stalled connect succeeds once the plugin answers");
        assert!(conn.is_connected());
        assert_echoes(conn.as_ref(), &mut rx, "after a slow connect").await;
    });
}

#[test]
fn concurrent_stalled_connects_leave_the_runtime_responsive() {
    let fixture = Fixture::new();
    current_thread().block_on(async {
        // More stalled connects than the runtime has worker threads (one).
        let connects: Vec<_> = (0..3)
            .map(|_| {
                let mut conn = fixture.connection();
                tokio::spawn(async move { conn.connect(stalled()).await })
            })
            .collect();
        let started = Instant::now();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(started.elapsed() < PROMPT, "the runtime stayed responsive");
        for connect in connects {
            // The runner serves plugin calls one at a time, so the three
            // creates queue behind each other there — each still gets an
            // answer within the create deadline.
            let _ = tokio::time::timeout(Duration::from_secs(30), connect)
                .await
                .expect("each connect finishes");
        }
    });
}

#[test]
fn cancelling_a_stalled_connect_returns_promptly_and_cleans_up() {
    let fixture = Fixture::new();
    let pid = fixture.handle().running().and_then(|r| r.pid()).unwrap();
    current_thread().block_on(async {
        let mut conn = fixture.connection();
        let token = CancellationToken::new();
        let cancel = token.clone();
        let connect = tokio::spawn(async move {
            let result = conn.connect_cancellable(stalled(), Some(cancel)).await;
            (conn, result)
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!connect.is_finished(), "the plugin is still connecting");

        let cancelled_at = Instant::now();
        token.cancel();
        let (conn, result) = tokio::time::timeout(PROMPT, connect)
            .await
            .expect("Cancel returns promptly, not when the plugin answers")
            .unwrap();
        assert!(cancelled_at.elapsed() < PROMPT);
        let err = result.expect_err("a cancelled connect fails");
        assert!(err.to_string().contains("cancelled"), "{err}");
        assert!(!conn.is_connected());

        // Once the plugin answers, the abandoned session is closed in the
        // runner: nothing is left behind.
        assert!(
            eventually(|| fixture.sessions() == 0).await,
            "the abandoned session is closed once the plugin answers"
        );
        // A user's Cancel is not a hang: the runner was not killed for it.
        let runner = fixture.handle().running().expect("the runner still runs");
        assert_eq!(runner.pid(), Some(pid));
        assert_eq!(fixture.handle().health().crashes, 0);

        // The plugin keeps serving new connections.
        let mut again = fixture.connection();
        let mut rx = again.subscribe_output();
        again
            .connect(serde_json::json!({}))
            .await
            .expect("a fresh connect after a cancel works");
        assert_echoes(again.as_ref(), &mut rx, "after cancel").await;
    });
}

#[test]
fn a_pre_cancelled_token_aborts_the_connect_without_a_session() {
    let fixture = Fixture::new();
    current_thread().block_on(async {
        let mut conn = fixture.connection();
        let token = CancellationToken::new();
        token.cancel();
        let started = Instant::now();
        let err = conn
            .connect_cancellable(stalled(), Some(token))
            .await
            .expect_err("a pre-cancelled connect fails");
        assert!(started.elapsed() < PROMPT);
        assert!(err.to_string().contains("cancelled"), "{err}");
        assert!(!conn.is_connected());
        assert!(eventually(|| fixture.sessions() == 0).await);
    });
}

#[test]
fn a_live_token_connect_and_disconnect_work_normally() {
    let fixture = Fixture::new();
    current_thread().block_on(async {
        let mut conn = fixture.connection();
        let mut rx = conn.subscribe_output();
        conn.connect_cancellable(serde_json::json!({}), Some(CancellationToken::new()))
            .await
            .expect("a connect with a live token succeeds");
        assert!(conn.is_connected());
        assert_eq!(fixture.sessions(), 1);
        assert_echoes(conn.as_ref(), &mut rx, "hello").await;

        conn.disconnect().await.expect("disconnect");
        assert!(!conn.is_connected());
        assert_eq!(fixture.sessions(), 0, "disconnect closed the session");
        // Connecting twice is still refused while connected.
        conn.connect(serde_json::json!({})).await.unwrap();
        assert!(conn.connect(serde_json::json!({})).await.is_err());
        conn.disconnect().await.unwrap();
    });
}
