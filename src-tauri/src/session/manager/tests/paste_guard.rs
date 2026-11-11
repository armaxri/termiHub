//! A same-session paste of a file onto itself, or of a folder into its own
//! subtree, is refused on the backend before anything is written (#5330).
//! The mock browser has no backend resolver, so it resolves lexically: a
//! `..`, a `.` and repeated slashes are seen through.

use super::*;

fn mock_session() -> Box<FileConnection> {
    Box::new(FileConnection {
        browser: MockFileBrowser {
            listed: Arc::new(std::sync::Mutex::new(Vec::new())),
        },
    })
}

async fn manager() -> SessionManager {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    manager.insert_test_session("fs", mock_session()).await;
    manager
}

fn refusal(res: Result<(), TerminalError>) -> String {
    match res {
        Err(TerminalError::RemoteError(msg)) => msg,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn a_file_pasted_onto_itself_is_refused() {
    let manager = manager().await;
    for dest in ["/srv/f", "/srv/./f", "/srv/x/../f", "//srv//f"] {
        let msg = refusal(manager.ensure_paste_allowed("fs", "/srv/f", dest).await);
        assert!(
            msg.contains(&format!(
                "copy /srv/f to {dest} refused: source and destination are the same file"
            )),
            "{msg}"
        );
    }
}

#[tokio::test]
async fn a_folder_pasted_into_its_own_subtree_is_refused() {
    let manager = manager().await;
    for dest in ["/srv/data/copy", "/srv/data/a/b", "/srv/x/../data/copy"] {
        let msg = refusal(
            manager
                .ensure_paste_allowed("fs", MOCK_FOLDER_PATH, dest)
                .await,
        );
        assert!(
            msg.contains("refused: the destination is inside the source folder"),
            "{msg}"
        );
    }
}

#[tokio::test]
async fn an_unrelated_destination_or_a_missing_source_is_allowed() {
    let manager = manager().await;
    manager
        .ensure_paste_allowed("fs", MOCK_FOLDER_PATH, "/srv/data2")
        .await
        .expect("a sibling with a shared prefix");
    manager
        .ensure_paste_allowed("fs", "/srv/f", "/srv/g")
        .await
        .expect("a different file");
    manager
        .ensure_paste_allowed("fs", MOCK_MISSING_PATH, "/srv/missing/x")
        .await
        .expect("a missing source is left to the paste's own error");
}

#[tokio::test]
async fn an_unknown_session_is_not_found() {
    let manager = manager().await;
    assert!(matches!(
        manager.ensure_paste_allowed("ghost", "/a", "/a/b").await,
        Err(TerminalError::SessionNotFound(_))
    ));
}
