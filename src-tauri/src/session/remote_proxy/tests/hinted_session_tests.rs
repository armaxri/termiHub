//! Pastes between two agent-hosted SSH sessions that only **may** share a
//! filesystem (#5430): another login on one server, or two sessions opened
//! from one saved definition.
//!
//! Each agent double serves a session's view of a server as a real temp
//! folder: `/srv/...` in the session is `<root>/srv/...` on disk. Two logins
//! without a jail share one root, so the source shows the same entry through
//! both sessions and a paste onto it is refused. Two jailed logins each have
//! their own root: the same path shows another entry and the paste copies.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, SystemTime};

use termihub_core::files::shared_fs::FilesystemHint;
use termihub_core::files::transfer::remote_copy::RemoteCopyEndpoint;

use super::ranged_tests::{owned_proxy, types_reply};
use super::realpath_tests::methods;
use super::*;
use crate::commands::transfer::ensure_remote_copy_allowed;
use crate::session::manager::SessionManager;
use termihub_core::connection::ConnectionTypeRegistry;

/// A server's files as one login sees them: `<root>/srv/f` (written at
/// `mtime` seconds past the epoch) and the folder `<root>/srv/sub`.
struct View {
    _dir: tempfile::TempDir,
    root: String,
}

impl View {
    fn new(mtime: u64) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path())
            .expect("canonical tempdir")
            .to_string_lossy()
            .into_owned();
        std::fs::create_dir_all(format!("{root}/srv/sub")).expect("mkdir");
        let file = format!("{root}/srv/f");
        std::fs::write(&file, b"payload").expect("write");
        let at = SystemTime::UNIX_EPOCH + Duration::from_secs(mtime);
        for path in [file, format!("{root}/srv")] {
            std::fs::File::open(&path)
                .and_then(|f| f.set_modified(at))
                .expect("set mtime");
        }
        Self { _dir: dir, root }
    }

    fn disk(&self, path: &str) -> String {
        format!("{}{path}", self.root)
    }
}

/// An agent double serving `root` as the session's `/`: `realpath` and
/// `stat` with a real mtime and mode, nothing else.
fn serve_view(root: String) -> Box<Responder> {
    Box::new(move |method, params| {
        let path = params["path"].as_str().unwrap_or_default();
        let disk = format!("{root}{path}");
        let fail = |message: String| Some(Err(TerminalError::RemoteError(message)));
        match method {
            "connection.files.realpath" => {
                let p = Path::new(&disk);
                let real = std::fs::canonicalize(p).ok().or_else(|| {
                    let parent = std::fs::canonicalize(p.parent()?).ok()?;
                    Some(parent.join(p.file_name()?))
                });
                match real.and_then(|r| {
                    r.to_string_lossy()
                        .strip_prefix(root.as_str())
                        .map(String::from)
                }) {
                    Some(real) => Some(Ok(json!({ "path": real }))),
                    None => fail(format!("not found: {path}")),
                }
            }
            "connection.files.stat" => match std::fs::metadata(&disk) {
                Ok(meta) => {
                    let mtime = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or_default();
                    Some(Ok(json!({
                        "name": "x",
                        "path": path,
                        "isDirectory": meta.is_dir(),
                        "size": meta.len(),
                        "modified": format!("{mtime}"),
                        "permissions": format!("{:o}", meta.permissions().mode() & 0o777),
                        "writable": null
                    })))
                }
                Err(e) => fail(format!("{path}: {e}")),
            },
            _ => None,
        }
    })
}

/// An agent-hosted SSH session on `agent-1` with `config`, served from
/// `root`.
async fn ssh_session(
    root: &str,
    config: serde_json::Value,
) -> (Arc<MockAgentRpcClient>, RemoteProxy) {
    let mut mock = MockAgentRpcClient::with_capabilities(types_reply("ssh"));
    mock.session_files = Some(true);
    mock.file_ranges = Some(true);
    mock.responder = Some(serve_view(root.to_string()));
    let mock = Arc::new(mock);
    let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());
    proxy
        .connect(json!({ "type": "ssh", "config": config }))
        .await
        .expect("connect should succeed");
    (mock, proxy)
}

fn login(user: &str) -> serde_json::Value {
    json!({"host": "build.example", "port": 22, "username": user, "authMethod": "agent"})
}

fn ranged(proxy: &RemoteProxy) -> RemoteCopyEndpoint {
    RemoteCopyEndpoint::Ranged(owned_proxy(proxy))
}

/// Bound a test so a stalled double fails it instead of hanging the run.
async fn bounded(test: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(Duration::from_secs(30), test)
        .await
        .expect("the test finishes");
}

#[tokio::test]
async fn sessions_report_a_hint_for_what_they_may_share() {
    bounded(async {
        let view = View::new(1_700_000_000);
        let (_, alice) = ssh_session(&view.root, login("alice")).await;
        let (_, bob) = ssh_session(&view.root, login("bob")).await;
        let hint = alice.file_browser().expect("browser").filesystem_hint();
        assert!(
            matches!(&hint, Some(FilesystemHint::Agent { .. })),
            "{hint:?}"
        );
        assert_eq!(hint, bob.file_browser().expect("browser").filesystem_hint());
        // Two logins are two exact ids: only the hint is shared.
        assert_ne!(
            alice.file_browser().expect("browser").filesystem_id(),
            bob.file_browser().expect("browser").filesystem_id()
        );
        let (_, saved) = ssh_session(&view.root, json!({"definitionId": "build"})).await;
        assert_eq!(
            saved.file_browser().expect("browser").filesystem_hint(),
            Some(FilesystemHint::AgentDefinition {
                agent_id: "agent-1".into(),
                definition_id: "build".into(),
            })
        );
    })
    .await;
}

/// Two logins on one server without a jail: the source shows the same entry
/// through both, so a file pasted onto itself is refused and keeps its
/// bytes, and a folder pasted into its own subtree creates nothing.
#[tokio::test]
async fn two_logins_sharing_files_refuse_a_paste_onto_itself() {
    bounded(async {
        let view = View::new(1_700_000_000);
        let (alice_mock, alice) = ssh_session(&view.root, login("alice")).await;
        let (bob_mock, bob) = ssh_session(&view.root, login("bob")).await;
        for dest in ["/srv/f", "/srv/sub/../f"] {
            let err = ensure_remote_copy_allowed(
                ("a", &ranged(&alice), "/srv/f"),
                ("b", &ranged(&bob), dest),
            )
            .await
            .expect_err("the same file");
            assert_eq!(
                err.to_string(),
                format!(
                    "Operation failed: copy /srv/f to {dest} refused: \
                     source and destination are the same file"
                )
            );
        }
        assert_eq!(std::fs::read(view.disk("/srv/f")).unwrap(), b"payload");

        let manager = SessionManager::new(ConnectionTypeRegistry::new(), alice_mock.clone());
        manager.insert_test_session("a", Box::new(alice)).await;
        manager.insert_test_session("b", Box::new(bob)).await;
        let err = manager
            .ensure_paste_across_allowed("a", "b", "/srv", "/srv/sub/copy")
            .await
            .expect_err("inside the source");
        assert!(
            err.to_string()
                .ends_with("the destination is inside the source folder"),
            "{err}"
        );
        assert!(!Path::new(&view.disk("/srv/sub/copy")).exists());
        for mock in [&alice_mock, &bob_mock] {
            let sent = methods(mock);
            assert!(
                sent.iter()
                    .all(|m| m == "connection.files.realpath" || m == "connection.files.stat"),
                "nothing was written or deleted: {sent:?}"
            );
        }
        manager
            .ensure_paste_across_allowed("a", "b", "/srv", "/srv2")
            .await
            .expect("a sibling copies");
    })
    .await;
}

/// Two jailed logins: the same path is another entry in each jail, so the
/// paste goes ahead for a file and a folder alike.
#[tokio::test]
async fn two_jailed_logins_copy_the_same_path() {
    bounded(async {
        let (one, two) = (View::new(1_700_000_000), View::new(1_700_000_500));
        let (alice_mock, alice) = ssh_session(&one.root, login("alice")).await;
        let (_, bob) = ssh_session(&two.root, login("bob")).await;
        ensure_remote_copy_allowed(
            ("a", &ranged(&alice), "/srv/f"),
            ("b", &ranged(&bob), "/srv/f"),
        )
        .await
        .expect("another jail");

        let manager = SessionManager::new(ConnectionTypeRegistry::new(), alice_mock);
        manager.insert_test_session("a", Box::new(alice)).await;
        manager.insert_test_session("b", Box::new(bob)).await;
        manager
            .ensure_paste_across_allowed("a", "b", "/srv", "/srv/sub/copy")
            .await
            .expect("another jail");
    })
    .await;
}

/// Two sessions opened from one saved definition (no inline host) refuse a
/// paste onto the source they both show; the same definition on another
/// agent is another host and never refused.
#[tokio::test]
async fn sessions_of_one_definition_refuse_a_paste_onto_itself() {
    bounded(async {
        let view = View::new(1_700_000_000);
        let saved = json!({"definitionId": "build"});
        let (_, a) = ssh_session(&view.root, saved.clone()).await;
        let (_, b) = ssh_session(&view.root, saved.clone()).await;
        ensure_remote_copy_allowed(("a", &ranged(&a), "/srv/f"), ("b", &ranged(&b), "/srv/f"))
            .await
            .expect_err("one definition, one entry");

        let mut mock = MockAgentRpcClient::with_capabilities(types_reply("ssh"));
        mock.session_files = Some(true);
        mock.file_ranges = Some(true);
        mock.responder = Some(serve_view(view.root.clone()));
        let mut other = RemoteProxy::new("agent-2".to_string(), Arc::new(mock));
        other
            .connect(json!({ "type": "ssh", "config": saved }))
            .await
            .expect("connect should succeed");
        ensure_remote_copy_allowed(
            ("a", &ranged(&a), "/srv/f"),
            ("c", &ranged(&other), "/srv/f"),
        )
        .await
        .expect("another agent");
    })
    .await;
}
