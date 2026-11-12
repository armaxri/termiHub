//! Pastes between two **different** agent-hosted sessions (#5355).
//!
//! Two local sessions on one agent browse the same agent host. A file pasted
//! from one onto its own path through the other would stream through the
//! remote→remote executor, which truncates the destination before it reads
//! the source. The guard sees both sessions reach one filesystem and refuses
//! the paste before a byte moves. Sessions on two agents are two hosts: the
//! same path there is two files, and the copy runs as before.

use std::collections::HashMap;
#[cfg(unix)]
use std::path::Path;

use termihub_core::files::shared_fs::FilesystemId;
use termihub_core::files::transfer::remote_copy::{run_remote_copy, RemoteCopyEndpoint};
use termihub_core::files::transfer::{
    ProgressSink, TransferDirection, TransferRegistry, TransferStateTag,
};

use super::ranged_tests::{contents, owned_proxy, serve_files, types_reply};
#[cfg(unix)]
use super::realpath_tests::{methods, serve_host, Tree};
use super::*;
use crate::commands::transfer::ensure_remote_copy_allowed;
#[cfg(unix)]
use crate::session::manager::SessionManager;
#[cfg(unix)]
use termihub_core::connection::ConnectionTypeRegistry;

/// An agent double whose sessions are `session_type`, serving ranged slices.
fn agent_mock(session_type: &str, responder: Box<Responder>) -> Arc<FakeAgent> {
    let mut mock = proxy_agent(types_reply(session_type));
    mock.capabilities_mut().session_files = true;
    mock.capabilities_mut().file_ranges = true;
    mock.responder = Some(responder);
    Arc::new(mock)
}

/// A session of `session_type` with `config` on the agent `agent_id`.
async fn session(
    agent_id: &str,
    mock: &Arc<FakeAgent>,
    session_type: &str,
    config: serde_json::Value,
) -> RemoteProxy {
    let mut proxy = RemoteProxy::new(agent_id.to_string(), mock.clone());
    proxy
        .connect(json!({ "type": session_type, "config": config }))
        .await
        .expect("connect should succeed");
    proxy
}

/// A local session on the agent `agent_id`: it browses that agent host.
async fn local_session(agent_id: &str, mock: &Arc<FakeAgent>) -> RemoteProxy {
    session(agent_id, mock, "local", json!({})).await
}

/// [`serve_files`], also answering the zero-length slice probe a copy end
/// links with, as an agent serving `fileRanges` does.
fn serve_copy(files: Arc<Mutex<HashMap<String, Vec<u8>>>>) -> Box<Responder> {
    let inner = serve_files(files);
    Box::new(move |method, params| {
        let probe = method == "connection.files.read_range" && params["length"].as_u64() == Some(0);
        if probe {
            return Some(Ok(json!({ "data": "", "eof": true })));
        }
        inner(method, params)
    })
}

fn ranged(proxy: &RemoteProxy) -> RemoteCopyEndpoint {
    RemoteCopyEndpoint::Ranged(owned_proxy(proxy))
}

#[tokio::test]
async fn sessions_report_the_filesystem_they_browse() {
    let mock = agent_mock("local", serve_files(Arc::default()));
    let local = local_session("agent-1", &mock).await;
    let browser = local.file_browser().expect("file browser");
    assert_eq!(
        browser.filesystem_id(),
        Some(FilesystemId::agent_host("agent-1"))
    );

    let mock = agent_mock("ssh", serve_files(Arc::default()));
    let config = json!({"host": "Build.example", "port": 22, "username": "ci",
                        "authMethod": "agent"});
    let ssh = session("agent-1", &mock, "ssh", config.clone()).await;
    let again = session("agent-1", &mock, "ssh", config).await;
    let id = ssh.file_browser().expect("browser").filesystem_id();
    assert!(matches!(&id, Some(FilesystemId::Agent { .. })), "{id:?}");
    assert_eq!(id, again.file_browser().expect("browser").filesystem_id());
    // A session opened from a saved definition carries no inline host.
    let by_definition = session("agent-1", &mock, "ssh", json!({"definitionId": "d"})).await;
    assert_eq!(
        by_definition
            .file_browser()
            .expect("browser")
            .filesystem_id(),
        None
    );

    let mock = agent_mock("docker", serve_files(Arc::default()));
    let docker = session("agent-1", &mock, "docker", json!({"image": "alpine"})).await;
    assert_eq!(
        docker.file_browser().expect("browser").filesystem_id(),
        None
    );
}

/// Two local sessions on one agent host: a file pasted onto itself through
/// the other session is refused before the destination is opened, whatever
/// the spelling, and keeps its bytes.
#[cfg(unix)]
#[tokio::test]
async fn a_file_pasted_onto_itself_across_two_sessions_is_refused() {
    let tree = Tree::new();
    let mock = agent_mock("local", serve_host(true));
    let (a, b) = (
        local_session("agent-1", &mock).await,
        local_session("agent-1", &mock).await,
    );
    let src = tree.path("data/f");
    for dest in [src.clone(), tree.path("link/f"), tree.path("data/sub/../f")] {
        let err = ensure_remote_copy_allowed(("a", &ranged(&a), &src), ("b", &ranged(&b), &dest))
            .await
            .expect_err("the destination is the source");
        assert_eq!(
            err.to_string(),
            format!(
                "Operation failed: copy {src} to {dest} refused: \
                 source and destination are the same file"
            )
        );
    }
    assert_eq!(std::fs::read(&src).unwrap(), b"payload");
    let sent = methods(&mock);
    assert!(
        sent.iter().all(|m| m == "connection.files.realpath"),
        "nothing but realpath reached the agent: {sent:?}"
    );

    ensure_remote_copy_allowed(
        ("a", &ranged(&a), &src),
        ("b", &ranged(&b), &tree.path("link/g")),
    )
    .await
    .expect("another file on the same host copies");
}

/// A folder pasted from one session into its own subtree through the other
/// is refused, and nothing is created.
#[cfg(unix)]
#[tokio::test]
async fn a_folder_pasted_into_itself_across_two_sessions_is_refused() {
    let tree = Tree::new();
    let mock = agent_mock("local", serve_host(true));
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), mock.clone());
    manager
        .insert_test_session("a", Box::new(local_session("agent-1", &mock).await))
        .await;
    manager
        .insert_test_session("b", Box::new(local_session("agent-1", &mock).await))
        .await;

    let src = tree.path("data");
    for dest in [
        tree.path("data/sub/copy"),
        tree.path("link/copy"),
        tree.path("link/sub/copy"),
    ] {
        let err = manager
            .ensure_paste_across_allowed("a", "b", &src, &dest)
            .await
            .expect_err("inside the source");
        assert!(
            err.to_string()
                .ends_with("the destination is inside the source folder"),
            "{err}"
        );
        assert!(!Path::new(&dest).exists(), "nothing was created");
    }
    manager
        .ensure_paste_across_allowed("a", "b", &src, &tree.path("link"))
        .await
        .expect_err("the alias is the source folder itself");
    let sent = methods(&mock);
    assert!(
        sent.iter()
            .all(|m| m == "connection.files.realpath" || m == "connection.files.stat"),
        "nothing was written or deleted: {sent:?}"
    );
    manager
        .ensure_paste_across_allowed("a", "b", &src, &tree.path("data2"))
        .await
        .expect("a sibling copies");
}

/// The same tree served by two agents stands in for two hosts with the same
/// path: never refused, even where one agent host would refuse it.
#[cfg(unix)]
#[tokio::test]
async fn the_same_path_on_two_agents_is_never_refused() {
    let tree = Tree::new();
    let (one, two) = (
        agent_mock("local", serve_host(true)),
        agent_mock("local", serve_host(true)),
    );
    let (a, b) = (
        local_session("agent-1", &one).await,
        local_session("agent-2", &two).await,
    );
    let src = tree.path("data/f");
    ensure_remote_copy_allowed(("a", &ranged(&a), &src), ("b", &ranged(&b), &src))
        .await
        .expect("two hosts");

    let manager = SessionManager::new(ConnectionTypeRegistry::new(), one.clone());
    manager.insert_test_session("a", Box::new(a)).await;
    manager.insert_test_session("b", Box::new(b)).await;
    manager
        .ensure_paste_across_allowed("a", "b", &tree.path("data"), &tree.path("data/sub/x"))
        .await
        .expect("two hosts");
    // Two hosts are never asked to resolve anything.
    assert!(methods(&one).is_empty(), "{:?}", methods(&one));
    assert!(methods(&two).is_empty(), "{:?}", methods(&two));
}

/// Two hosts with the same path: the guard lets the copy through and it
/// lands byte-exact on the other host.
#[tokio::test]
async fn a_copy_between_two_agents_with_the_same_path_runs() {
    let data = contents(300 * 1024 + 7);
    let src_files = Arc::new(Mutex::new(HashMap::from([(
        "/srv/f".to_string(),
        data.clone(),
    )])));
    let dst_files = Arc::new(Mutex::new(HashMap::new()));
    let one = agent_mock("local", serve_copy(src_files.clone()));
    let two = agent_mock("local", serve_copy(dst_files.clone()));
    let (a, b) = (
        local_session("agent-1", &one).await,
        local_session("agent-2", &two).await,
    );
    let (src, dst) = (ranged(&a), ranged(&b));
    ensure_remote_copy_allowed(("a", &src, "/srv/f"), ("b", &dst, "/srv/f"))
        .await
        .expect("two hosts");

    let registry = TransferRegistry::new();
    let handle = registry.enqueue("copy", "b", TransferDirection::Upload, "f", "/srv/f", 0);
    let sink: ProgressSink = Arc::new(|_| {});
    let copy = run_remote_copy(
        src,
        dst,
        "/srv/f".into(),
        "/srv/f".into(),
        handle.clone(),
        registry,
        sink,
        termihub_core::files::transfer::remote_copy::DEFAULT_RESUME_MODE,
        0,
    );
    tokio::time::timeout(std::time::Duration::from_secs(30), copy)
        .await
        .expect("the copy finishes");
    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(dst_files.lock().unwrap()["/srv/f"], data);
    assert_eq!(src_files.lock().unwrap()["/srv/f"], data);
}
