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

use std::process::Command;
use std::time::{Duration, Instant};

use termihub_core::backends::docker::Docker;
use termihub_core::connection::ConnectionType;

/// Whether a Docker/Podman CLI can reach a daemon (used for the pre-flight skip
/// and for the stop-not-remove assertion via container listing).
fn docker_cli_available() -> bool {
    Command::new("docker")
        .arg("info")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// List `(name, state)` for all containers named with the `termihub-` prefix.
fn list_termihub_containers() -> Vec<(String, String)> {
    let output = Command::new("docker")
        .args([
            "ps",
            "-a",
            "--filter",
            "name=termihub-",
            "--format",
            "{{.Names}}\t{{.State}}",
        ])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (name, state) = line.split_once('\t')?;
            Some((name.trim().to_string(), state.trim().to_lowercase()))
        })
        .collect()
}

#[tokio::test]
async fn docker_spawn_mounts_directory_and_opens_cd_to_mount() {
    if !docker_cli_available() {
        eprintln!(
            "SKIPPED: no reachable Docker daemon \
             (directory-mount container spawn integration test, #1372)"
        );
        return;
    }

    // A unique host directory with a marker file only visible if the bind mount
    // works inside the container.
    let host_dir = std::env::temp_dir().join(format!("termihub-spawn-it-{}", std::process::id()));
    std::fs::create_dir_all(&host_dir).expect("create host dir");
    let marker_content = "termihub-1372-mounted-ok";
    std::fs::write(host_dir.join("mount-check.txt"), marker_content).expect("write marker");

    let before: Vec<String> = list_termihub_containers()
        .into_iter()
        .map(|(n, _)| n)
        .collect();

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
        let _ = std::fs::remove_dir_all(&host_dir);
        return;
    }

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

    let new_containers: Vec<(String, String)> = list_termihub_containers()
        .into_iter()
        .filter(|(name, _)| !before.contains(name))
        .collect();

    // Clean up before asserting so a failure never leaks a container or dir.
    for (name, _) in &new_containers {
        let _ = Command::new("docker").args(["rm", "-f", name]).output();
    }
    let _ = std::fs::remove_dir_all(&host_dir);

    assert!(
        buf.contains(marker_content),
        "bind-mounted file content should be readable inside the container; output: {buf:?}"
    );
    assert!(
        buf.contains("/workspace"),
        "shell should open cd'd into the mount target; output: {buf:?}"
    );
    assert_eq!(
        new_containers.len(),
        1,
        "spawn should create exactly one container; found: {new_containers:?}"
    );
    assert_ne!(
        new_containers[0].1, "running",
        "closing the session must stop (not remove) the container; state: {:?}",
        new_containers[0]
    );
}
