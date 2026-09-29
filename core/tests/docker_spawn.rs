#![cfg(feature = "docker")]
//! Integration test: directory-mount container spawn (#1372).
//!
//! Exercises the Docker backend the way the "new container" spawn path drives
//! it — a host directory bind-mounted at `/workspace`, the interactive shell
//! opening `cd`'d into the mount, and `removeOnExit: false` so closing the
//! session stops (but does not remove) the container.
//!
//! Requires a reachable Docker (or Podman) daemon and pulls the small `alpine`
//! image on first run. Skips gracefully (like the other backend integration
//! tests) when no daemon is available, so it is safe in CI without Docker. Only
//! compiled with `--features docker`, keeping it out of the default unit path.
//!
//! ## Why this observes through the backend's own runtime client (#1585, #3888)
//!
//! The daemon the backend talks to is not necessarily the one the `docker` CLI
//! or a bare `bollard::Docker::connect_with_local_defaults()` reaches: on macOS
//! with Docker Desktop and Podman, the backend follows the active Docker CLI
//! context while `/var/run/docker.sock` points at the Podman machine. Observing
//! through a separately-resolved client asserted against the wrong daemon, never
//! saw the spawned container and leaked it on every run (#3888). The test now
//! observes through [`support::container::runtime_client`], which calls the
//! backend's own `connect_to_runtime`, and a [`CleanupGuard`] removes the
//! container (by the id the backend reports) and the bind-mount directory even
//! when an assertion panics.

mod support;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use bollard::container::ListContainersOptions;
use support::container::{runtime_client, CleanupGuard};
use termihub_core::backends::docker::Docker;
use termihub_core::connection::ConnectionType;

/// List `(name, state)` for the containers **this test process** spawned.
///
/// The backend names containers `termihub-<millis>-<pid>`, so scoping to our
/// own PID isolates this test from the `termihub-test-*` fixture containers and
/// from any other checkout running the same test concurrently.
async fn list_spawned_containers(client: &bollard::Docker) -> Vec<(String, String)> {
    let suffix = format!("-{}", std::process::id());
    let mut filters = HashMap::new();
    filters.insert("name", vec!["termihub-"]);
    let options = ListContainersOptions {
        all: true,
        filters,
        ..Default::default()
    };
    let Ok(containers) = client.list_containers(Some(options)).await else {
        return Vec::new();
    };
    containers
        .into_iter()
        .filter_map(|c| {
            // The API returns names with a leading slash.
            let name = c.names?.first()?.trim_start_matches('/').to_string();
            let state = c.state?.to_lowercase();
            name.ends_with(&suffix).then_some((name, state))
        })
        .collect()
}

#[tokio::test]
async fn docker_spawn_mounts_directory_and_opens_cd_to_mount() {
    let Some(client) = runtime_client().await else {
        eprintln!(
            "SKIPPED: no reachable container daemon \
             (directory-mount container spawn integration test, #1372)"
        );
        return;
    };

    // Everything registered here is removed on drop — also when an assertion
    // below panics — so a failing run never leaks a container or directory.
    let mut cleanup = CleanupGuard::default();

    // A unique host directory with a marker file only visible if the bind mount
    // works inside the container.
    let host_dir = std::env::temp_dir().join(format!("termihub-spawn-it-{}", std::process::id()));
    cleanup.dir(&host_dir);
    std::fs::create_dir_all(&host_dir).expect("create host dir");
    let marker_content = "termihub-1372-mounted-ok";
    std::fs::write(host_dir.join("mount-check.txt"), marker_content).expect("write marker");

    // The exact settings shape the spawn path builds: single writable bind at
    // /workspace, working directory = mount, stopped-not-removed on close.
    let settings = serde_json::json!({
        "image": "alpine:3",
        "shell": "/bin/sh",
        "workingDirectory": "/workspace",
        "removeOnExit": false,
        "volumes": [{
            "hostPath": host_dir.to_str().expect("utf8 path"),
            "containerPath": "/workspace",
            "readOnly": false,
        }],
    });

    let mut docker = Docker::new();
    if let Err(e) = docker.connect(settings).await {
        eprintln!("SKIPPED: docker connect/pull failed ({e}); treating daemon as unavailable");
        return;
    }
    let container_id = docker
        .container_id()
        .expect("connected session reports its container")
        .to_string();
    cleanup.container(&container_id);

    let mut rx = docker.subscribe_output();
    // Let the interactive shell settle before driving it.
    tokio::time::sleep(Duration::from_millis(500)).await;
    docker
        .write(b"pwd; cat /workspace/mount-check.txt\n")
        .expect("write to spawned shell");

    // Collect output until both the mount cwd and the file content appear.
    let mut buf = String::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
            Ok(Some(chunk)) => {
                buf.push_str(&String::from_utf8_lossy(&chunk));
                if buf.contains(marker_content) && buf.contains("/workspace") {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => {}
        }
    }

    // Closing the session stops the container (remove_on_exit = false).
    docker.disconnect().await.ok();
    // Give the daemon a moment to record the stopped state.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let spawned = list_spawned_containers(&client).await;

    assert!(
        buf.contains(marker_content),
        "bind-mounted file content should be readable inside the container; output: {buf:?}"
    );
    assert!(
        buf.contains("/workspace"),
        "shell should open cd'd into the mount target; output: {buf:?}"
    );
    assert_eq!(
        spawned.len(),
        1,
        "spawn should create exactly one container (backend id {container_id}); \
         found: {spawned:?}"
    );
    assert_ne!(
        spawned[0].1, "running",
        "closing the session must stop (not remove) the container; state: {:?}",
        spawned[0]
    );
}
