//! Capability refresh across an in-place reconnect (#4440).
//!
//! The desktop decides by an agent's `initialize` capabilities. When the agent
//! binary changes underneath a live connection (an update or a downgrade) and
//! the in-task transport reconnect re-launches it, the cached capabilities and
//! the agents region must follow the new answer — a downgrade drops every flag
//! the older agent lacks.
//!
//! * [`refresh_agent_capabilities`] replaces the cache and region wholesale.
//! * Over the real connect + I/O task + reconnect path against the in-process
//!   [`FakeAgentSshd`] (unix: the transport sever is unix-test-only), a
//!   reconnect to a downgraded / upgraded agent updates `get_capabilities`, the
//!   output flow decision and the region.

use std::sync::Arc;

use serde_json::json;
use tauri::Manager;

use super::capabilities::{refresh_agent_capabilities, SharedCapabilities};
use super::tests::make_agent_connection;
use super::AgentCapabilities;
use crate::agents_projection::store::AgentsStore;
use termihub_core::files::FileAttributeOps;

/// A capability set as a 0.29.0 agent reports it.
fn rich() -> AgentCapabilities {
    let mut caps = make_agent_connection(true).capabilities.get();
    caps.output_flow = true;
    caps.file_ranges = true;
    caps.session_files = true;
    caps.host_file_attribute_ops = Some(FileAttributeOps {
        permissions: true,
        owner: false,
        symlink: true,
    });
    caps.agent_version = "0.29.0".to_string();
    caps
}

/// A capability set as an older agent reports it: no optional flag.
fn minimal() -> AgentCapabilities {
    let mut caps = make_agent_connection(true).capabilities.get();
    caps.agent_version = "0.26.0".to_string();
    caps
}

/// A mock app whose agents region knows `agent_id`.
fn app_with_region(agent_id: &str) -> (tauri::App<tauri::test::MockRuntime>, Arc<AgentsStore>) {
    let app = tauri::test::mock_app();
    let store = Arc::new(AgentsStore::new());
    store.add(agent_id, "Agent", json!({}), json!({}));
    app.manage(store.clone());
    (app, store)
}

fn region_capabilities(store: &AgentsStore, agent_id: &str) -> serde_json::Value {
    store
        .get(agent_id)
        .and_then(|a| a.capabilities)
        .expect("the region records the capabilities")
}

#[test]
fn a_downgrade_drops_the_flags_the_older_agent_lacks() {
    let (app, store) = app_with_region("a");
    let shared = SharedCapabilities::from(rich());

    refresh_agent_capabilities(app.handle(), "a", &shared, minimal());

    let cached = shared.get();
    assert!(!cached.output_flow);
    assert!(!shared.output_flow());
    assert!(!cached.file_ranges);
    assert!(!cached.session_files);
    assert_eq!(cached.host_file_attribute_ops, None);
    assert_eq!(cached.agent_version, "0.26.0");

    let region = region_capabilities(&store, "a");
    assert_eq!(region["outputFlow"], json!(false));
    assert_eq!(region["fileRanges"], json!(false));
    assert!(region.get("hostFileAttributeOps").is_none());
    assert_eq!(region["agentVersion"], json!("0.26.0"));
}

#[test]
fn an_update_adds_the_flags_the_newer_agent_reports() {
    let (app, store) = app_with_region("a");
    let shared = SharedCapabilities::from(minimal());

    refresh_agent_capabilities(app.handle(), "a", &shared, rich());

    let cached = shared.get();
    assert!(cached.output_flow);
    assert!(cached.file_ranges);
    assert_eq!(
        cached.host_file_attribute_ops,
        Some(FileAttributeOps {
            permissions: true,
            owner: false,
            symlink: true,
        })
    );
    let region = region_capabilities(&store, "a");
    assert_eq!(region["outputFlow"], json!(true));
    assert_eq!(
        region["hostFileAttributeOps"],
        json!({ "permissions": true, "owner": false, "symlink": true })
    );
    assert_eq!(region["agentVersion"], json!("0.29.0"));
}

#[test]
fn the_cache_is_refreshed_without_an_agents_store() {
    let app = tauri::test::mock_app();
    let shared = SharedCapabilities::from(rich());

    refresh_agent_capabilities(app.handle(), "a", &shared, minimal());

    assert!(!shared.output_flow());
}

/// The full shipped path: connect, sever the transport, and let the I/O task's
/// in-task reconnect re-initialize a different agent binary.
#[cfg(unix)]
mod over_the_reconnect_path {
    use std::sync::Arc;
    use std::time::Duration;

    use tauri::test::MockRuntime;
    use tauri::Manager;

    use super::super::fake_agent_sshd::{
        FakeAgentSshd, InitBehavior, MINIMAL_AGENT_VERSION, RICH_AGENT_VERSION,
    };
    use super::super::{AgentConnectionManager, AgentRpcClient};
    use super::{json, region_capabilities, AgentsStore};

    /// Ceiling for any one step against the loopback fake agent; the first
    /// reconnect attempt waits a ~1 s backoff.
    const STEP: Duration = Duration::from_secs(30);

    const AGENT: &str = "agent-caps";

    fn trust_all_host_keys() {
        use termihub_core::backends::ssh::host_key::{
            set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
        };
        struct TrustAll;
        #[async_trait::async_trait]
        impl HostKeyVerifier for TrustAll {
            async fn verify(&self, _info: &HostKeyInfo) -> bool {
                true
            }
        }
        let _ = set_host_key_verifier(Arc::new(TrustAll));
    }

    struct Connected {
        server: FakeAgentSshd,
        _app: tauri::App<MockRuntime>,
        store: Arc<AgentsStore>,
        manager: Arc<AgentConnectionManager<MockRuntime>>,
    }

    async fn connected(behavior: InitBehavior) -> Connected {
        trust_all_host_keys();
        let server = FakeAgentSshd::serve(behavior).await;
        let app = tauri::test::mock_app();
        let store = Arc::new(AgentsStore::new());
        store.add(AGENT, "Agent", json!({}), json!({}));
        app.manage(store.clone());
        let manager = Arc::new(AgentConnectionManager::new(app.handle().clone()));
        let (m, cfg) = (manager.clone(), server.agent_config());
        tokio::time::timeout(
            STEP,
            tokio::task::spawn_blocking(move || m.connect_agent(AGENT, &cfg, None)),
        )
        .await
        .expect("connect settles")
        .expect("connect join")
        .expect("the fake agent connects");
        Connected {
            server,
            _app: app,
            store,
            manager,
        }
    }

    /// Sever the transport and wait until the agent re-initialized and the
    /// cache reports `agent_version`.
    async fn reconnect_to(c: &Connected, agent_version: &str) {
        assert!(c.manager.test_sever_transport(AGENT));
        c.server.wait_for_inits(2, STEP).await;
        let deadline = tokio::time::Instant::now() + STEP;
        loop {
            let current = c
                .manager
                .get_capabilities(AGENT)
                .map(|caps| caps.agent_version);
            if current.as_deref() == Some(agent_version) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "capabilities still report {current:?} after the reconnect, \
                 expected agent version {agent_version}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_reconnect_to_a_downgraded_agent_drops_its_missing_flags() {
        let c = connected(InitBehavior::DowngradeOnReconnect).await;
        let before = c.manager.get_capabilities(AGENT).expect("connected");
        assert!(before.output_flow);
        assert!(before.file_ranges);
        assert!(before.host_file_attribute_ops.is_some());
        assert_eq!(before.agent_version, RICH_AGENT_VERSION);
        assert!(c.manager.supports_output_flow(AGENT));

        reconnect_to(&c, MINIMAL_AGENT_VERSION).await;

        let after = c.manager.get_capabilities(AGENT).expect("still connected");
        assert!(!after.output_flow);
        assert!(!after.file_ranges);
        assert_eq!(after.host_file_attribute_ops, None);
        assert!(!c.manager.supports_output_flow(AGENT));
        let region = region_capabilities(&c.store, AGENT);
        assert_eq!(region["outputFlow"], json!(false));
        assert!(region.get("hostFileAttributeOps").is_none());
        assert_eq!(region["agentVersion"], json!(MINIMAL_AGENT_VERSION));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_reconnect_to_an_updated_agent_adopts_its_new_flags() {
        let c = connected(InitBehavior::UpgradeOnReconnect).await;
        assert!(!c.manager.supports_output_flow(AGENT));

        reconnect_to(&c, RICH_AGENT_VERSION).await;

        let after = c.manager.get_capabilities(AGENT).expect("still connected");
        assert!(after.output_flow);
        assert!(after.file_ranges);
        assert!(after.host_file_attribute_ops.is_some());
        assert!(c.manager.supports_output_flow(AGENT));
        let region = region_capabilities(&c.store, AGENT);
        assert_eq!(region["outputFlow"], json!(true));
        assert_eq!(region["agentVersion"], json!(RICH_AGENT_VERSION));
    }
}
