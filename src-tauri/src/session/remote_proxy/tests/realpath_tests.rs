//! Same-session pastes of agent-hosted sessions resolve both paths on the
//! agent host (`connection.files.realpath`, protocol 0.36.0, #5333).
//!
//! An agent double serves a real temp directory: `realpath` canonicalizes on
//! it (a missing final name through its parent), and `stat` / ranged slices
//! read and write its files. A paste through a symlink alias is refused before
//! a single byte moves, so the ranged writer can never open its own source.
//! An agent from before 0.36.0 answers "method not found" and the guard keeps
//! the lexical check of #5330 exactly.

use std::path::Path;

use base64::Engine;
use termihub_core::files::transfer::remote_copy::{ensure_copy_within_allowed, RemoteCopyEndpoint};

use super::ranged_tests::{mock_agent, owned_proxy};
use super::*;
use crate::session::manager::SessionManager;
use termihub_core::connection::ConnectionTypeRegistry;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// `<root>/data/f` (and the folder `<root>/data/sub`), reachable through
/// the symlinked folder `<root>/link`.
struct Tree {
    _dir: tempfile::TempDir,
    root: String,
}

impl Tree {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path())
            .expect("canonical tempdir")
            .to_string_lossy()
            .into_owned();
        std::fs::create_dir_all(format!("{root}/data/sub")).expect("mkdir");
        std::fs::write(format!("{root}/data/f"), b"payload").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink(format!("{root}/data"), format!("{root}/link")).expect("link");
        Self { _dir: dir, root }
    }

    fn path(&self, rel: &str) -> String {
        format!("{}/{rel}", self.root)
    }
}

/// `realpath` the way the agent answers it: canonical, a missing final name
/// through its parent folder.
fn agent_realpath(path: &str) -> Option<String> {
    if let Ok(real) = std::fs::canonicalize(path) {
        return Some(real.to_string_lossy().into_owned());
    }
    let p = Path::new(path);
    let parent = std::fs::canonicalize(p.parent()?).ok()?;
    Some(parent.join(p.file_name()?).to_string_lossy().into_owned())
}

/// An agent double over the real filesystem. With `realpath: false` it is an
/// agent from before 0.36.0, which answers that method "not found".
fn serve_host(realpath: bool) -> Box<Responder> {
    Box::new(move |method, params| {
        let path = params["path"].as_str().unwrap_or_default().to_string();
        let fail = |message: String| Some(Err(TerminalError::RemoteError(message)));
        match method {
            "connection.files.realpath" if !realpath => Some(Err(TerminalError::AgentUnsupported(
                "Method not found".into(),
            ))),
            "connection.files.realpath" => match agent_realpath(&path) {
                Some(real) => Some(Ok(json!({ "path": real }))),
                None => fail(format!("not found: {path}")),
            },
            "connection.files.stat" => match std::fs::metadata(&path) {
                Ok(meta) => Some(Ok(json!({
                    "name": "x",
                    "path": path,
                    "isDirectory": meta.is_dir(),
                    "size": meta.len(),
                    "modified": "2026-11-11T12:00:00Z",
                    "permissions": null,
                    "writable": null
                }))),
                Err(e) => fail(format!("{path}: {e}")),
            },
            "connection.files.read_range" => {
                let data = std::fs::read(&path).ok()?;
                let offset = params["offset"].as_u64().unwrap() as usize;
                let length = params["length"].as_u64().unwrap() as usize;
                let start = offset.min(data.len());
                let end = (start + length).min(data.len());
                Some(Ok(json!({
                    "data": B64.encode(&data[start..end]),
                    "eof": end - start < length,
                })))
            }
            // A write the guard must prevent: truncate at 0, like the agent.
            "connection.files.write_range" => {
                let data = B64.decode(params["data"].as_str().unwrap()).unwrap();
                std::fs::write(&path, data).unwrap();
                Some(Ok(json!({})))
            }
            _ => None,
        }
    })
}

async fn agent(realpath: bool) -> (Arc<MockAgentRpcClient>, RemoteProxy) {
    let mut mock = mock_agent(true, true);
    mock.responder = Some(serve_host(realpath));
    let mock = Arc::new(mock);
    let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());
    proxy
        .connect(json!({ "type": "docker", "config": {"image": "alpine"} }))
        .await
        .expect("connect should succeed");
    (mock, proxy)
}

fn methods(mock: &MockAgentRpcClient) -> Vec<String> {
    mock.sent_requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, _)| m.starts_with("connection.files."))
        .map(|(m, _)| m.clone())
        .collect()
}

/// A file pasted onto itself through a symlink alias on one agent session:
/// refused before the destination is opened, and the bytes stay intact.
#[cfg(unix)]
#[tokio::test]
async fn a_file_paste_through_an_alias_is_refused_and_keeps_the_bytes() {
    let tree = Tree::new();
    let (mock, proxy) = agent(true).await;
    let end = RemoteCopyEndpoint::Ranged(owned_proxy(&proxy));
    let src = tree.path("data/f");
    for dest in [tree.path("link/f"), tree.path("link/sub/../f")] {
        let err = ensure_copy_within_allowed(&end, &src, &dest)
            .await
            .expect_err("the alias is the source");
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
    // Resolved inside the agent-hosted session, never on the agent host.
    for (_, params) in mock.sent_requests.lock().unwrap().iter() {
        if params.get("path").is_some() {
            assert!(params["connection_id"].is_string(), "{params}");
        }
    }

    ensure_copy_within_allowed(&end, &src, &tree.path("link/g"))
        .await
        .expect("a different file copies");
}

/// A folder paste or cut through an alias into the source's own subtree is
/// refused, and nothing is created or deleted.
#[cfg(unix)]
#[tokio::test]
async fn a_folder_paste_through_an_alias_into_itself_is_refused() {
    let tree = Tree::new();
    let (mock, proxy) = agent(true).await;
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), mock.clone());
    manager.insert_test_session("agent", Box::new(proxy)).await;

    let src = tree.path("data");
    for dest in [tree.path("link/sub/copy"), tree.path("link/copy")] {
        let err = manager
            .ensure_paste_allowed("agent", &src, &dest)
            .await
            .expect_err("inside the source");
        assert!(
            err.to_string()
                .ends_with("the destination is inside the source folder"),
            "{err}"
        );
        assert!(!Path::new(&dest).exists(), "nothing was created");
    }
    // The source spelled through the alias, the destination real.
    manager
        .ensure_paste_allowed("agent", &tree.path("link"), &tree.path("data/sub/x"))
        .await
        .expect_err("the alias's own subtree");
    let sent = methods(&mock);
    assert!(
        sent.iter()
            .all(|m| m == "connection.files.realpath" || m == "connection.files.stat"),
        "nothing was written or deleted: {sent:?}"
    );
    assert_eq!(std::fs::read(tree.path("data/f")).unwrap(), b"payload");
    manager
        .ensure_paste_allowed("agent", &src, &tree.path("data2"))
        .await
        .expect("a sibling copies");
}

/// An agent from before 0.36.0: the guard is exactly the lexical one of
/// #5330. A respelled path is still refused; an alias it cannot see is not.
#[cfg(unix)]
#[tokio::test]
async fn an_old_agent_keeps_the_lexical_check() {
    let tree = Tree::new();
    let (mock, proxy) = agent(false).await;
    let end = RemoteCopyEndpoint::Ranged(owned_proxy(&proxy));
    let src = tree.path("data/f");
    ensure_copy_within_allowed(&end, &src, &tree.path("data/sub/../f"))
        .await
        .expect_err("lexically the source");
    ensure_copy_within_allowed(&end, &src, &tree.path("link/f"))
        .await
        .expect("an alias is invisible to an old agent, as before");

    let manager = SessionManager::new(ConnectionTypeRegistry::new(), mock.clone());
    manager.insert_test_session("agent", Box::new(proxy)).await;
    manager
        .ensure_paste_allowed("agent", &tree.path("data"), &tree.path("x/../data/copy"))
        .await
        .expect_err("lexically inside the source");
    manager
        .ensure_paste_allowed("agent", &tree.path("data"), &tree.path("link/copy"))
        .await
        .expect("an alias is invisible to an old agent, as before");
    assert_eq!(std::fs::read(&src).unwrap(), b"payload");
}

/// An agent too old to browse the session is not asked to resolve anything.
#[tokio::test]
async fn an_outdated_agent_is_not_asked() {
    let mut mock = mock_agent(false, false);
    mock.responder = Some(serve_host(true));
    let mock = Arc::new(mock);
    let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());
    proxy
        .connect(json!({ "type": "docker", "config": {"image": "alpine"} }))
        .await
        .expect("connect should succeed");
    let browser = proxy.file_browser().expect("file browser");
    assert!(browser.path_canonicalizer().is_none());
    assert!(methods(&mock).is_empty());
}
