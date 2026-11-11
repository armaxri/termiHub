//! A copy between two **different** sessions that reach one filesystem
//! (#5355): both ends resolve their own path, and a copy of a file onto
//! itself is refused before the destination is opened. Ends that do not
//! surely share a filesystem are never refused.

use super::*;
use crate::files::shared_fs::FilesystemId;

/// The agent host of `agent`, as a ranged end reports it.
fn host(agent: &str) -> Option<FilesystemId> {
    Some(FilesystemId::agent_host(agent))
}

/// An end on `fs` resolving `/alias` to `/d`, holding `/d/f`.
fn end_on(fs: Option<FilesystemId>, links: bool) -> Arc<MemRanged> {
    let target = Arc::new(MemRanged {
        links: links.then(|| HashMap::from([("/alias".to_string(), "/d".to_string())])),
        fs_id: fs,
        ..MemRanged::default()
    });
    target.put("/d/f", content(16, 9), 1);
    target
}

fn ranged(target: &Arc<MemRanged>) -> RemoteCopyEndpoint {
    RemoteCopyEndpoint::Ranged(target.clone())
}

/// Two sessions on one agent host share its files: the second session's
/// view is the same store.
#[tokio::test]
async fn a_copy_onto_itself_across_two_sessions_is_refused_and_keeps_the_bytes() {
    let shared = end_on(host("agent-1"), true);
    let (a, b) = (ranged(&shared), ranged(&shared));
    for dest in ["/d/f", "/d/./f", "/d/x/../f", "/alias/f"] {
        let err = ensure_copy_across_allowed(&a, "/d/f", &b, dest)
            .await
            .expect_err(&format!("{dest} is the source"));
        assert_eq!(
            err.to_string(),
            format!(
                "Operation failed: copy /d/f to {dest} refused: \
                 source and destination are the same file"
            )
        );
    }
    assert_eq!(shared.get("/d/f"), Some(content(16, 9)));
    assert!(shared.writes().is_empty(), "nothing may be written");
    ensure_copy_across_allowed(&a, "/d/f", &b, "/alias/g")
        .await
        .expect("another file on the same host copies");
}

/// Without `realpath` (an older agent) the lexical check is the floor, as
/// within one session.
#[tokio::test]
async fn ends_without_realpath_keep_the_lexical_floor() {
    let shared = end_on(host("agent-1"), false);
    let (a, b) = (ranged(&shared), ranged(&shared));
    ensure_copy_across_allowed(&a, "/d/f", &b, "/d/x/../f")
        .await
        .expect_err("lexically the source");
    ensure_copy_across_allowed(&a, "/d/f", &b, "/alias/f")
        .await
        .expect("an alias is invisible without realpath");
}

/// Two hosts with the same path are two files: never refused.
#[tokio::test]
async fn the_same_path_on_two_hosts_is_never_refused() {
    let (one, two) = (end_on(host("agent-1"), true), end_on(host("agent-2"), true));
    ensure_copy_across_allowed(&ranged(&one), "/d/f", &ranged(&two), "/d/f")
        .await
        .expect("two hosts");
}

/// An end that cannot tell its filesystem is never taken for the other's.
#[tokio::test]
async fn an_end_without_an_identity_is_never_refused() {
    let shared = end_on(None, true);
    ensure_copy_across_allowed(&ranged(&shared), "/d/f", &ranged(&shared), "/d/f")
        .await
        .expect("no identity, no refusal");
    let known = end_on(host("agent-1"), true);
    ensure_copy_across_allowed(&ranged(&known), "/d/f", &ranged(&shared), "/d/f")
        .await
        .expect("one end cannot tell");
}
