#![cfg(feature = "docker")]
//! Integration test: directory-mount container spawn (#1372).
//!
//! Exercises the Docker backend the way the "new container" spawn path drives
//! it — a host directory bind-mounted at `/workspace`, the interactive shell
//! opening `cd`'d into the mount, and `removeOnExit: false` so closing the
//! session stops (but does not remove) the container.
//!
//! Two variants run the same scenario (#4010):
//!
//! * `docker_spawn_mounts_directory_and_opens_cd_to_mount` — the default `auto`
//!   runtime (Docker when present). Runs in the Docker-fixture lane
//!   (`integration-fixtures.yml`), where `TERMIHUB_REQUIRE_DOCKER=1` turns an
//!   unreachable daemon into a hard failure instead of a skip.
//! * `podman_spawn_mounts_directory_and_opens_cd_to_mount` — an explicit
//!   `runtime: podman` session. The same lane starts a rootless Podman API
//!   socket on the ubuntu runner and sets `TERMIHUB_REQUIRE_PODMAN=1`.
//!
//! Each pulls the small `alpine` image on first run and skips gracefully when
//! its runtime is unreachable and not required, so it is safe locally and in
//! the per-PR gate. Only compiled with `--features docker`, keeping it out of
//! the default unit path.
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

use bollard::container::{InspectContainerOptions, ListContainersOptions};
use support::container::{runtime_client_for, runtime_required, CleanupGuard};
use support::fixture_env::require_reported;
use termihub_core::backends::docker::Docker;
use termihub_core::config::ContainerRuntime;
use termihub_core::connection::ConnectionType;

/// List `(name, state)` for the containers **this test process** spawned.
///
/// The backend names containers `termihub-<millis>-<pid>`, so scoping to our
/// own PID isolates this test from the `termihub-test-*` fixture containers and
/// from any other checkout running the same test concurrently.
///
/// A list failure is returned rather than read as "no containers": on a host
/// whose daemon has an unrelated broken container (e.g. a Podman machine with a
/// dangling layer) the list endpoint itself errors, and that must not masquerade
/// as the spawn having created nothing.
async fn list_spawned_containers(
    client: &bollard::Docker,
) -> Result<Vec<(String, String)>, bollard::errors::Error> {
    let suffix = format!("-{}", std::process::id());
    let mut filters = HashMap::new();
    filters.insert("name", vec!["termihub-"]);
    let options = ListContainersOptions {
        all: true,
        filters,
        ..Default::default()
    };
    let containers = client.list_containers(Some(options)).await?;
    Ok(containers
        .into_iter()
        .filter_map(|c| {
            // The API returns names with a leading slash.
            let name = c.names?.first()?.trim_start_matches('/').to_string();
            let state = c.state?.to_lowercase();
            name.ends_with(&suffix).then_some((name, state))
        })
        .collect())
}

/// The state (`running`, `exited`, …) of the container with this id, read by
/// inspecting it directly so the check never depends on the list endpoint.
async fn container_state(client: &bollard::Docker, id: &str) -> Option<String> {
    let info = client
        .inspect_container(id, None::<InspectContainerOptions>)
        .await
        .ok()?;
    Some(info.state?.status?.to_string().to_lowercase())
}

/// Spawn a directory-mount container session through `runtime` and assert the
/// shell opens in `/workspace`, the host marker file is visible through the bind
/// mount, and closing the session leaves the container exited (not removed).
///
/// `require_env` names the variable that makes an unreachable runtime a hard
/// failure rather than a skip; `label` names the runtime in messages.
async fn assert_directory_mount_spawn(runtime: ContainerRuntime, require_env: &str, label: &str) {
    let required = runtime_required(require_env);
    let Some(client) = runtime_client_for(&runtime).await else {
        require_reported(
            false,
            required,
            format_args!(
                "no reachable {label} daemon \
                 (directory-mount container spawn integration test, #1372)"
            ),
            format_args!(
                "{require_env} is set but no {label} daemon is reachable \
                 (directory-mount container spawn integration test, #1372)"
            ),
        );
        return;
    };

    // Everything registered here is removed on drop — also when an assertion
    // below panics — so a failing run never leaks a container or directory.
    let mut cleanup = CleanupGuard::for_runtime(runtime.clone());

    // A unique host directory with a marker file only visible if the bind mount
    // works inside the container.
    let host_dir =
        std::env::temp_dir().join(format!("termihub-spawn-it-{label}-{}", std::process::id()));
    cleanup.dir(&host_dir);
    std::fs::create_dir_all(&host_dir).expect("create host dir");
    let marker_content = "termihub-1372-mounted-ok";
    std::fs::write(host_dir.join("mount-check.txt"), marker_content).expect("write marker");

    // The exact settings shape the spawn path builds: single writable bind at
    // /workspace, working directory = mount, stopped-not-removed on close.
    let settings = serde_json::json!({
        "image": "alpine:3",
        "shell": "/bin/sh",
        "runtime": runtime,
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
        require_reported(
            false,
            required,
            format_args!("{label} connect/pull failed ({e}); treating daemon as unavailable"),
            format_args!("{require_env} is set but the {label} spawn failed to connect/pull: {e}"),
        );
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

    let state = container_state(&client, &container_id).await;
    let spawned = list_spawned_containers(&client).await;

    assert!(
        buf.contains(marker_content),
        "bind-mounted file content should be readable inside the {label} container; \
         output: {buf:?}"
    );
    assert!(
        buf.contains("/workspace"),
        "shell should open cd'd into the mount target; output: {buf:?}"
    );
    // Closing the session must stop — not remove — the container: it is still
    // inspectable, and no longer running.
    let state = state.unwrap_or_else(|| {
        panic!("the {label} container {container_id} must still exist after close (not removed)")
    });
    assert_ne!(
        state, "running",
        "closing the session must stop (not remove) the container; state: {state}"
    );
    // And the spawn created exactly one container. Skipped (loudly) only when
    // the daemon's list endpoint itself errors for reasons outside this test.
    match spawned {
        Ok(spawned) => assert_eq!(
            spawned.len(),
            1,
            "spawn should create exactly one {label} container (backend id {container_id}); \
             found: {spawned:?}"
        ),
        Err(e) => eprintln!(
            "WARNING: {label} container list failed ({e}); single-container check skipped"
        ),
    }
}

#[tokio::test]
async fn docker_spawn_mounts_directory_and_opens_cd_to_mount() {
    assert_directory_mount_spawn(ContainerRuntime::Auto, "TERMIHUB_REQUIRE_DOCKER", "docker").await;
}

/// Podman variant (#4010): an explicit `runtime: podman` session reaches the
/// Podman API socket (`CONTAINER_HOST` or the rootless `$XDG_RUNTIME_DIR`
/// socket) and behaves exactly like the Docker spawn.
#[tokio::test]
async fn podman_spawn_mounts_directory_and_opens_cd_to_mount() {
    assert_directory_mount_spawn(
        ContainerRuntime::Podman,
        "TERMIHUB_REQUIRE_PODMAN",
        "podman",
    )
    .await;
}
