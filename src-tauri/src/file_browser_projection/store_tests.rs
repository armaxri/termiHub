//! State-machine tests for [`FileBrowserStore`], proving the file-browser view
//! authority matches the frontend `appStore` reducers: the per-pane load
//! lifecycle (`loadStarted` → `loadSucceeded` / `loadFailed`), the idle-baseline
//! reset, the active-mode selection, the copy/cut clipboard, the independence of
//! the three panes, and the per-client isolation the client-scoped region needs.

use super::*;

const C: &str = "client-1";

/// A minimal directory entry for a listing (the fields the browser distinguishes
/// on; the rest default).
fn entry(name: &str, is_directory: bool) -> FileEntry {
    FileEntry {
        name: name.to_string(),
        path: format!("/{name}"),
        is_directory,
        size: 0,
        modified: String::new(),
        permissions: None,
        writable: None,
        is_symlink: false,
        symlink_target: None,
    }
}

#[test]
fn a_fresh_client_is_the_idle_baseline() {
    let store = FileBrowserStore::new();
    let view = store.snapshot(C);
    assert_eq!(view["mode"], json!("none"));
    for pane in ["local", "sftp", "session"] {
        assert_eq!(view[pane]["path"], json!("/"), "{pane} path");
        assert_eq!(view[pane]["entries"], json!([]), "{pane} entries");
        assert_eq!(view[pane]["loading"], json!(false), "{pane} loading");
        assert_eq!(view[pane]["error"], Value::Null, "{pane} error");
    }
    assert_eq!(view["clipboard"], Value::Null);
}

#[test]
fn set_mode_selects_the_active_pane_and_none_clears_it() {
    let store = FileBrowserStore::new();
    store.set_mode(C, Some(FileBrowserKind::Sftp));
    assert_eq!(store.snapshot(C)["mode"], json!("sftp"));
    store.set_mode(C, Some(FileBrowserKind::Local));
    assert_eq!(store.snapshot(C)["mode"], json!("local"));
    store.set_mode(C, None);
    assert_eq!(store.snapshot(C)["mode"], json!("none"));
}

#[test]
fn load_started_marks_loading_and_clears_a_prior_error() {
    let store = FileBrowserStore::new();
    store.load_failed(C, FileBrowserKind::Local, Some("boom".to_string()));
    assert_eq!(store.snapshot(C)["local"]["error"], json!("boom"));

    store.load_started(C, FileBrowserKind::Local);
    let view = store.snapshot(C);
    assert_eq!(view["local"]["loading"], json!(true));
    assert_eq!(view["local"]["error"], Value::Null);
}

#[test]
fn load_succeeded_commits_path_and_listing_and_clears_loading() {
    let store = FileBrowserStore::new();
    store.load_started(C, FileBrowserKind::Sftp);
    store.load_succeeded(
        C,
        FileBrowserKind::Sftp,
        "/var/log",
        vec![entry("syslog", false), entry("nginx", true)],
    );
    let view = store.snapshot(C);
    assert_eq!(view["sftp"]["path"], json!("/var/log"));
    assert_eq!(view["sftp"]["loading"], json!(false));
    assert_eq!(view["sftp"]["error"], Value::Null);
    assert_eq!(view["sftp"]["entries"][0]["name"], json!("syslog"));
    assert_eq!(view["sftp"]["entries"][0]["isDirectory"], json!(false));
    assert_eq!(view["sftp"]["entries"][1]["name"], json!("nginx"));
    assert_eq!(view["sftp"]["entries"][1]["isDirectory"], json!(true));
    assert_eq!(
        store.pane_state(C, FileBrowserKind::Sftp),
        Some(("/var/log".to_string(), 2, false))
    );
}

#[test]
fn load_failed_keeps_the_last_good_listing_and_records_the_error() {
    let store = FileBrowserStore::new();
    store.load_succeeded(C, FileBrowserKind::Local, "/home", vec![entry("a", false)]);
    // A later failed navigation keeps the prior path/listing (mirrors the catch
    // branch, which only sets loading:false + error).
    store.load_started(C, FileBrowserKind::Local);
    store.load_failed(C, FileBrowserKind::Local, Some("denied".to_string()));
    let view = store.snapshot(C);
    assert_eq!(view["local"]["path"], json!("/home"), "path retained");
    assert_eq!(
        view["local"]["entries"][0]["name"],
        json!("a"),
        "listing retained"
    );
    assert_eq!(view["local"]["loading"], json!(false));
    assert_eq!(view["local"]["error"], json!("denied"));
}

#[test]
fn reset_pane_returns_it_to_the_idle_baseline() {
    let store = FileBrowserStore::new();
    store.load_succeeded(C, FileBrowserKind::Session, "/tmp", vec![entry("x", false)]);
    store.load_failed(C, FileBrowserKind::Session, Some("e".to_string()));
    store.reset_pane(C, FileBrowserKind::Session);
    let view = store.snapshot(C);
    assert_eq!(view["session"]["path"], json!("/"));
    assert_eq!(view["session"]["entries"], json!([]));
    assert_eq!(view["session"]["loading"], json!(false));
    assert_eq!(view["session"]["error"], Value::Null);
}

#[test]
fn set_clipboard_stores_a_copy_and_null_clears_it() {
    let store = FileBrowserStore::new();
    store.set_clipboard(
        C,
        Some(Clipboard {
            entries: vec![entry("f", false)],
            operation: ClipboardOperation::Copy,
            source_mode: FileBrowserKind::Sftp,
            source_path: "/src".to_string(),
            sftp_session_id: Some("sess-1".to_string()),
            terminal_session_id: None,
        }),
    );
    let view = store.snapshot(C);
    assert_eq!(view["clipboard"]["operation"], json!("copy"));
    assert_eq!(view["clipboard"]["sourceMode"], json!("sftp"));
    assert_eq!(view["clipboard"]["sourcePath"], json!("/src"));
    assert_eq!(view["clipboard"]["sftpSessionId"], json!("sess-1"));
    assert_eq!(view["clipboard"]["terminalSessionId"], Value::Null);
    assert_eq!(view["clipboard"]["entries"][0]["name"], json!("f"));

    store.set_clipboard(C, None);
    assert_eq!(store.snapshot(C)["clipboard"], Value::Null);
}

#[test]
fn a_cut_clipboard_records_the_cut_operation() {
    let store = FileBrowserStore::new();
    store.set_clipboard(
        C,
        Some(Clipboard {
            entries: vec![entry("d", true)],
            operation: ClipboardOperation::Cut,
            source_mode: FileBrowserKind::Local,
            source_path: "/a".to_string(),
            sftp_session_id: None,
            terminal_session_id: Some("term-9".to_string()),
        }),
    );
    let view = store.snapshot(C);
    assert_eq!(view["clipboard"]["operation"], json!("cut"));
    assert_eq!(view["clipboard"]["sourceMode"], json!("local"));
    assert_eq!(view["clipboard"]["terminalSessionId"], json!("term-9"));
    assert_eq!(view["clipboard"]["sftpSessionId"], Value::Null);
}

#[test]
fn the_three_panes_are_independent() {
    let store = FileBrowserStore::new();
    store.load_succeeded(C, FileBrowserKind::Local, "/l", vec![entry("l", false)]);
    store.load_succeeded(
        C,
        FileBrowserKind::Sftp,
        "/s",
        vec![entry("s1", false), entry("s2", false)],
    );
    store.load_started(C, FileBrowserKind::Session);
    let view = store.snapshot(C);
    // Local committed, sftp committed with two, session still loading at baseline.
    assert_eq!(view["local"]["path"], json!("/l"));
    assert_eq!(view["sftp"]["path"], json!("/s"));
    assert_eq!(view["sftp"]["entries"].as_array().unwrap().len(), 2);
    assert_eq!(view["session"]["path"], json!("/"));
    assert_eq!(view["session"]["loading"], json!(true));
}

#[test]
fn browser_state_is_isolated_per_client() {
    let store = FileBrowserStore::new();
    store.set_mode("a", Some(FileBrowserKind::Sftp));
    store.load_succeeded("a", FileBrowserKind::Sftp, "/a", vec![entry("a", false)]);
    store.set_mode("b", Some(FileBrowserKind::Local));

    // Client b is untouched by client a's mutations.
    let vb = store.snapshot("b");
    assert_eq!(vb["mode"], json!("local"));
    assert_eq!(vb["sftp"]["path"], json!("/"));
    assert_eq!(vb["sftp"]["entries"], json!([]));

    // ...and a keeps its own state.
    let va = store.snapshot("a");
    assert_eq!(va["mode"], json!("sftp"));
    assert_eq!(va["sftp"]["path"], json!("/a"));
}
