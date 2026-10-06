//! Relaunching agent-hosted queued transfers after a restart (#4114), against
//! the agent double: the identity a transfer records, how a relaunch picks the
//! reconnected session by it, and that the transfer then resumes from the
//! persisted offset.

use std::collections::HashMap;

use termihub_core::files::transfer::ranged::run_ranged_transfer;
use termihub_core::files::transfer::{
    ProgressSink, TransferDirection, TransferRegistry, TransferStateTag, CHUNK_SIZE,
};

use super::ranged_tests::{contents, mock_agent, owned_proxy, serve_files};
use super::*;
use crate::files::transfer::persist::PersistedAgentTarget;
use crate::files::transfer::relaunch_agent::{resolve_agent_target, AgentSessionIdentity};
use crate::files::transfer::relaunch_credentials::RelaunchBlocked;

/// A connected agent session on `agent_id`, opened from `definition`.
async fn session_on(
    agent_id: &str,
    definition: Option<&str>,
    mock: Arc<MockAgentRpcClient>,
) -> RemoteProxy {
    let mut config = json!({ "image": "alpine" });
    if let Some(definition) = definition {
        config["definitionId"] = json!(definition);
    }
    let mut proxy = RemoteProxy::new(agent_id.to_string(), mock);
    proxy
        .connect(json!({ "type": "docker", "config": config }))
        .await
        .expect("connect should succeed");
    proxy
}

/// The candidates a relaunch sees: each live session's identity and proxy.
fn live(proxies: &[&RemoteProxy]) -> Vec<(AgentSessionIdentity, Arc<RemoteFileBrowserProxy>)> {
    proxies
        .iter()
        .map(|p| {
            let owned = owned_proxy(p);
            (owned.agent_session_identity(), owned)
        })
        .collect()
}

/// The persisted identity of a transfer started before the restart: its
/// agent-side session is gone; the definition it was opened from remains.
fn persisted(definition: Option<&str>) -> PersistedAgentTarget {
    PersistedAgentTarget {
        agent_id: "agent-1".to_string(),
        remote_session_id: "remote-before-restart".to_string(),
        definition_id: definition.map(str::to_string),
    }
}

async fn resolve(
    persisted: &PersistedAgentTarget,
    live: Vec<(AgentSessionIdentity, Arc<RemoteFileBrowserProxy>)>,
) -> Result<Arc<RemoteFileBrowserProxy>, RelaunchBlocked> {
    resolve_agent_target(
        persisted,
        live,
        |proxy: Arc<RemoteFileBrowserProxy>| async move {
            proxy.probe_ranges().await.map_err(|e| e.to_string())
        },
    )
    .await
}

/// An agent double serving `files` that also answers the zero-length ranged
/// probe, as an agent with `fileRanges` does without touching the backend.
fn serve_with_probe(files: Arc<Mutex<HashMap<String, Vec<u8>>>>) -> Box<Responder> {
    let serve = serve_files(files);
    Box::new(move |method, params| {
        if method == "connection.files.read_range" && params["length"].as_u64() == Some(0) {
            return Some(Ok(json!({ "data": "", "eof": false })));
        }
        serve(method, params)
    })
}

/// A ranged-capable agent double that answers the probe.
fn probing_agent(files: Arc<Mutex<HashMap<String, Vec<u8>>>>) -> Arc<MockAgentRpcClient> {
    let mut mock = mock_agent(true, true);
    mock.responder = Some(serve_with_probe(files));
    Arc::new(mock)
}

fn sink() -> ProgressSink {
    Arc::new(|_| {})
}

/// A transfer records who serves its session: the agent, the agent-side
/// session id and the definition the session was opened from — ids only.
#[tokio::test]
async fn a_transfer_records_the_agent_session_identity() {
    let mock = Arc::new(mock_agent(true, true));
    let mut proxy = session_on("agent-1", Some("def-a"), mock).await;
    let recorded = owned_proxy(&proxy).agent_session_identity().to_persisted();
    assert_eq!(
        recorded,
        PersistedAgentTarget {
            agent_id: "agent-1".to_string(),
            remote_session_id: "mock-session-1".to_string(),
            definition_id: Some("def-a".to_string()),
        }
    );
    let json = serde_json::to_string(&recorded).unwrap();
    assert!(
        !json.contains("password") && !json.contains("alpine"),
        "ids only, no settings: {json}"
    );
    proxy.disconnect().await.ok();
}

/// After a restart, the session reopened from the same definition on the same
/// agent is found, and the transfer resumes from the persisted offset: the
/// first data slice is read at the offset, and the file arrives byte-exact.
#[tokio::test]
async fn a_reconnected_session_resumes_the_transfer_from_its_offset() {
    let files = Arc::new(Mutex::new(HashMap::new()));
    let remote = contents(CHUNK_SIZE * 2 + 333);
    files
        .lock()
        .unwrap()
        .insert("/srv/down.bin".to_string(), remote.clone());
    let mock = probing_agent(files);
    let mut reopened = session_on("agent-1", Some("def-a"), mock.clone()).await;

    let target = resolve(&persisted(Some("def-a")), live(&[&reopened]))
        .await
        .expect("the reopened session matches");

    // The partial written before the restart.
    let offset = CHUNK_SIZE as u64;
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("down.bin");
    std::fs::write(&local, &remote[..CHUNK_SIZE]).unwrap();
    let registry = TransferRegistry::new();
    let handle = registry.enqueue(
        "dl",
        "desktop-session-after-restart",
        TransferDirection::Download,
        "down.bin",
        "/srv/down.bin",
        remote.len() as u64,
    );
    mock.sent_requests.lock().unwrap().clear();
    run_ranged_transfer(
        target,
        TransferDirection::Download,
        "/srv/down.bin".into(),
        local.to_string_lossy().into_owned(),
        handle.clone(),
        registry,
        sink(),
        offset,
    )
    .await;

    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(std::fs::read(&local).unwrap(), remote);
    let data_reads: Vec<u64> = mock
        .sent_requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, p)| m == "connection.files.read_range" && p["length"].as_u64() != Some(0))
        .map(|(_, p)| p["offset"].as_u64().unwrap())
        .collect();
    assert_eq!(
        data_reads.first(),
        Some(&offset),
        "resumed at the offset, not from zero: {data_reads:?}"
    );
    reopened.disconnect().await.ok();
}

/// A session with a mismatched identity is refused — another agent with the
/// same definition, or the same agent for another definition — and the row
/// keeps waiting for the agent instead of resuming into another file system.
#[tokio::test]
async fn a_session_with_another_identity_is_refused() {
    let mock = Arc::new(mock_agent(true, true));
    let mut other_agent = session_on("agent-2", Some("def-a"), mock.clone()).await;
    let mut other_definition = session_on("agent-1", Some("def-b"), mock.clone()).await;
    let mut ad_hoc = session_on("agent-1", None, mock).await;

    let err = resolve(
        &persisted(Some("def-a")),
        live(&[&other_agent, &other_definition, &ad_hoc]),
    )
    .await
    .err()
    .expect("no session matches");
    assert_eq!(err, RelaunchBlocked::AgentSessionUnavailable);
    assert!(err.message().contains("reconnect the agent"), "{err:?}");

    for proxy in [&mut other_agent, &mut other_definition, &mut ad_hoc] {
        proxy.disconnect().await.ok();
    }
}

/// The original agent-side session, still live in this run, is used directly.
#[tokio::test]
async fn the_original_agent_session_is_reused_while_live() {
    let mock = probing_agent(Arc::default());
    let mut original = session_on("agent-1", None, mock).await;
    let identity = owned_proxy(&original).agent_session_identity();
    let resolved = resolve(&identity.to_persisted(), live(&[&original])).await;
    assert!(resolved.is_ok(), "{:?}", resolved.err());
    original.disconnect().await.ok();
}
