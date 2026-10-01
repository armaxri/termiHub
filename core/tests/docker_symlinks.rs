#![cfg(feature = "docker")]
//! Live Docker-container symlink listing (#1523, #4006).
//!
//! The listing parser is unit-tested in `core/src/backends/docker/file_browser.rs`;
//! this test runs the real in-container listing script against real links in a
//! throwaway `alpine:3` container (busybox userland, the minimal-tools case) and
//! asserts what the browser reports: `is_symlink`, the link target, and a
//! link-to-directory listed as a directory.
//!
//! Spawns its container through the Docker backend itself and observes through
//! [`runtime_client`], which resolves the daemon the same way the backend does
//! (#3888). A [`CleanupGuard`] removes the container even when an assertion
//! panics. Skips when no container daemon is reachable.

mod support;

use std::collections::HashMap;

use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use futures_util::StreamExt;
use support::container::{runtime_client, CleanupGuard};
use termihub_core::backends::docker::Docker;
use termihub_core::connection::ConnectionType;
use termihub_core::files::FileEntry;

/// Run `cmd` via `sh -c` in `container` and return its combined output.
async fn sh(client: &bollard::Docker, container: &str, cmd: &str) -> String {
    let exec = client
        .create_exec(
            container,
            CreateExecOptions {
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                cmd: Some(vec!["sh", "-c", cmd]),
                ..Default::default()
            },
        )
        .await
        .expect("create exec");
    let mut out = String::new();
    if let StartExecResults::Attached { mut output, .. } = client
        .start_exec(&exec.id, None::<StartExecOptions>)
        .await
        .expect("start exec")
    {
        while let Some(Ok(frame)) = output.next().await {
            out.push_str(&frame.to_string());
        }
    }
    out
}

#[tokio::test]
async fn docker_list_dir_reports_symlink_metadata() {
    let Some(client) = runtime_client().await else {
        eprintln!("SKIPPED: no reachable container daemon (Docker symlink listing, #4006)");
        return;
    };
    let mut cleanup = CleanupGuard::default();

    let settings = serde_json::json!({
        "image": "alpine:3",
        "shell": "/bin/sh",
        "removeOnExit": true,
    });
    let mut docker = Docker::new();
    if let Err(e) = docker.connect(settings).await {
        eprintln!("SKIPPED: docker connect/pull failed ({e}); treating daemon as unavailable");
        return;
    }
    let container = docker
        .container_id()
        .expect("connected session reports its container")
        .to_string();
    cleanup.container(&container);

    let dir = "/tmp/th-links";
    let setup = sh(
        &client,
        &container,
        &format!(
            "set -e; mkdir -p {dir}/target-dir; echo hello > {dir}/target.txt; \
             cd {dir}; ln -s target.txt file-link; ln -s target-dir dir-link; \
             ln -s /nonexistent/path broken-link; ln -s {dir}/target.txt abs-link; \
             echo SETUP_OK"
        ),
    )
    .await;
    assert!(setup.contains("SETUP_OK"), "link setup failed: {setup}");

    let browser = docker
        .file_browser()
        .expect("Docker exposes a file browser");
    let entries: HashMap<String, FileEntry> = browser
        .list_dir(dir)
        .await
        .expect("list the links dir")
        .into_iter()
        .map(|e| (e.name.clone(), e))
        .collect();
    let entry = |name: &str| {
        entries
            .get(name)
            .unwrap_or_else(|| panic!("{name} missing from listing: {entries:?}"))
    };

    for (name, target, is_dir) in [
        ("file-link", "target.txt", false),
        ("dir-link", "target-dir", true),
        ("broken-link", "/nonexistent/path", false),
        ("abs-link", "/tmp/th-links/target.txt", false),
    ] {
        let link = entry(name);
        assert!(link.is_symlink, "{name} is a symlink");
        assert_eq!(
            link.symlink_target.as_deref(),
            Some(target),
            "{name} target"
        );
        // A link to a directory lists as a directory, so the browser can open it.
        assert_eq!(link.is_directory, is_dir, "{name} is_directory");
        assert_eq!(link.path, format!("{dir}/{name}"), "{name} path");
    }
    for name in ["target.txt", "target-dir"] {
        assert!(!entry(name).is_symlink, "{name} is not a symlink");
        assert_eq!(entry(name).symlink_target, None, "{name} has no target");
    }

    // Following the links reaches the targets.
    let through = browser
        .read_file(&format!("{dir}/file-link"))
        .await
        .expect("read through the file link");
    assert_eq!(through, b"hello\n");
    let inside = browser
        .list_dir(&format!("{dir}/dir-link"))
        .await
        .expect("list through the dir link");
    assert!(inside.is_empty(), "the linked dir is empty: {inside:?}");

    docker.disconnect().await.ok();
}
