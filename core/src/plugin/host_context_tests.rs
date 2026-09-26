//! Unit tests for the host side of the ABI 1.1 host context (#3576).

use super::*;

fn state(id: &str) -> (Arc<ServicesState>, Arc<AtomicBool>) {
    let shutdown = Arc::new(AtomicBool::new(false));
    (
        ServicesState::new(id.to_owned(), Arc::clone(&shutdown)),
        shutdown,
    )
}

#[test]
fn handles_share_the_state_and_release_it_exactly() {
    let (state, _shutdown) = state("echo");
    assert_eq!(Arc::strong_count(&state), 1);
    let handle = ServicesState::handle(&state);
    assert_eq!(Arc::strong_count(&state), 2);
    let clone = handle.clone();
    assert_eq!(Arc::strong_count(&state), 3);
    drop(handle);
    drop(clone);
    assert_eq!(Arc::strong_count(&state), 1);
}

#[test]
fn cancellation_is_sticky_and_covers_session_and_plugin() {
    let (state, shutdown) = state("echo");
    let handle = ServicesState::handle(&state);
    assert!(!handle.is_cancelled());
    state.cancel();
    assert!(handle.is_cancelled());

    let (other, shutdown_other) = state_pair_sharing(&shutdown);
    let other_handle = ServicesState::handle(&other);
    assert!(!other_handle.is_cancelled());
    shutdown_other.store(true, Ordering::SeqCst);
    assert!(
        other_handle.is_cancelled(),
        "plugin shutdown cancels every session"
    );
}

fn state_pair_sharing(shutdown: &Arc<AtomicBool>) -> (Arc<ServicesState>, Arc<AtomicBool>) {
    (
        ServicesState::new("echo".to_owned(), Arc::clone(shutdown)),
        Arc::clone(shutdown),
    )
}

#[test]
fn a_handle_outliving_the_host_side_stays_valid() {
    // The plugin may keep a handle after the host dropped its own state Arc
    // (e.g. a detached worker thread): calls stay memory-safe.
    let (state, _shutdown) = state("echo");
    let handle = ServicesState::handle(&state);
    state.cancel();
    drop(state);
    assert!(handle.is_cancelled());
    handle.info("still fine");
}

#[test]
fn null_contexts_are_refused_not_dereferenced() {
    // SAFETY: null is explicitly tolerated by every callback.
    unsafe {
        services_retain(std::ptr::null_mut());
        services_release(std::ptr::null_mut());
        assert!(services_is_cancelled(std::ptr::null_mut()));
        assert_eq!(
            services_log(std::ptr::null_mut(), 3, FfiStr::new("x")),
            PluginStatus::Other
        );
    }
}

#[test]
fn log_rejects_an_unknown_level() {
    let (state, _shutdown) = state("echo");
    let handle = ServicesState::handle(&state);
    let ctx = Arc::as_ptr(&state).cast_mut().cast::<c_void>();
    for bad in [0, 6, u32::MAX] {
        // SAFETY: `handle` keeps `ctx` alive.
        let status = unsafe { services_log(ctx, bad, FfiStr::new("x")) };
        assert_eq!(status, PluginStatus::InvalidConfig, "level {bad}");
    }
    // SAFETY: as above.
    assert_eq!(
        unsafe { services_log(ctx, 3, FfiStr::new("ok")) },
        PluginStatus::Ok
    );
    drop(handle);
}

#[test]
fn log_reads_at_most_the_bound_of_an_oversized_message() {
    let (state, _shutdown) = state("echo");
    let handle = ServicesState::handle(&state);
    let ctx = Arc::as_ptr(&state).cast_mut().cast::<c_void>();
    // A message that claims to be far longer than its real buffer: the host
    // must read only the bounded prefix, which here is fully backed.
    let buf = vec![b'a'; MAX_LOG_MESSAGE_BYTES];
    let lying = FfiStr {
        ptr: buf.as_ptr(),
        len: usize::MAX,
    };
    // SAFETY: only the first MAX_LOG_MESSAGE_BYTES bytes (all backed) are read.
    assert_eq!(unsafe { services_log(ctx, 3, lying) }, PluginStatus::Ok);
    drop(handle);
}

#[test]
fn sanitize_strips_control_characters_replaces_bad_utf8_and_marks_truncation() {
    assert_eq!(sanitize_log_message(b"plain", false), "plain");
    assert_eq!(
        sanitize_log_message(b"line1\nfake [plugin] line2\r\x1b[31m", false),
        "line1 fake [plugin] line2  [31m"
    );
    assert_eq!(
        sanitize_log_message(b"bad \xff byte", false),
        "bad \u{fffd} byte"
    );
    assert_eq!(sanitize_log_message(b"cut", true), "cut …[truncated]");
    // Truncating mid-codepoint degrades to a replacement char, never a panic.
    let euro = "€".as_bytes();
    assert_eq!(
        sanitize_log_message(&euro[..2], true),
        "\u{fffd} …[truncated]"
    );
}

#[test]
fn log_lines_are_tagged_with_the_host_trusted_id() {
    assert_eq!(compose_plugin_log("echo", "hi"), "[echo] hi");
}

#[test]
fn data_dir_is_created_private_contained_and_stable() {
    let tmp = tempfile::TempDir::new().unwrap();
    let dir = prepare_plugin_data_dir(tmp.path(), "echo-backend").unwrap();
    let path = Path::new(&dir);
    assert!(path.is_dir());
    assert!(path.ends_with(Path::new(PLUGIN_DATA_DIR_NAME).join("echo-backend")));
    // Idempotent: a second call returns the same directory.
    assert_eq!(
        prepare_plugin_data_dir(tmp.path(), "echo-backend").unwrap(),
        dir
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }
}

#[test]
fn data_dir_refuses_ids_that_could_escape() {
    let tmp = tempfile::TempDir::new().unwrap();
    for bad in ["", "..", "../x", "a/b", "a\\b", "UPPER", ".data"] {
        assert!(
            matches!(
                prepare_plugin_data_dir(tmp.path(), bad),
                Err(PluginDataDirError::InvalidId(_))
            ),
            "{bad:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn data_dir_refuses_a_symlink_planted_in_its_place() {
    let tmp = tempfile::TempDir::new().unwrap();
    let outside = tempfile::TempDir::new().unwrap();
    std::fs::create_dir_all(tmp.path().join(PLUGIN_DATA_DIR_NAME)).unwrap();
    std::os::unix::fs::symlink(
        outside.path(),
        tmp.path().join(PLUGIN_DATA_DIR_NAME).join("echo"),
    )
    .unwrap();
    assert!(matches!(
        prepare_plugin_data_dir(tmp.path(), "echo"),
        Err(PluginDataDirError::NotADirectory(_))
    ));

    // Removing it unlinks the symlink without touching the target.
    std::fs::write(outside.path().join("keep"), b"x").unwrap();
    remove_plugin_data_dir(tmp.path(), "echo").unwrap();
    assert!(outside.path().join("keep").exists());
    assert!(!tmp.path().join(PLUGIN_DATA_DIR_NAME).join("echo").exists());
}

#[test]
fn remove_data_dir_deletes_it_and_tolerates_absence() {
    let tmp = tempfile::TempDir::new().unwrap();
    let dir = prepare_plugin_data_dir(tmp.path(), "echo").unwrap();
    std::fs::write(Path::new(&dir).join("state.json"), b"{}").unwrap();
    remove_plugin_data_dir(tmp.path(), "echo").unwrap();
    assert!(!Path::new(&dir).exists());
    remove_plugin_data_dir(tmp.path(), "echo").unwrap();
    remove_plugin_data_dir(tmp.path(), "../nope").unwrap();
}
