#![cfg(feature = "docker")]
//! Integration test: Docker stats monitoring fallback for distroless (#3202).
//!
//! A distroless image has no shell and no `/proc` tooling, so the `docker exec
//! sh -c <MONITORING_COMMAND>` monitoring probe fails. The Docker backend's
//! monitoring provider must then fall back to the Docker Engine stats API and
//! stream samples tagged `DockerStats`, with the metrics that API cannot supply
//! listed as unavailable.
//!
//! The session execs `python3` (the only interactive binary the
//! `gcr.io/distroless/python3-debian12` image ships) into an already-running
//! container. Requires a reachable daemon — the same one bollard resolves
//! (`DOCKER_HOST`, else `/var/run/docker.sock`), see `docker_spawn.rs` for why
//! the `docker` CLI is not used — and pulls the image on first run. Skips
//! gracefully when either is unavailable, so it is safe in CI without Docker.

use std::time::Duration;

use bollard::container::{
    Config, CreateContainerOptions, RemoveContainerOptions, StartContainerOptions,
};
use bollard::image::CreateImageOptions;
use futures_util::StreamExt;
use termihub_core::backends::docker::Docker;
use termihub_core::connection::ConnectionType;
use termihub_core::monitoring::{StatsMetric, StatsSource};

const DISTROLESS: &str = "gcr.io/distroless/python3-debian12:latest";
const ALPINE: &str = "alpine:3";

/// A reachable client for the daemon the backend's `Auto` runtime reaches.
async fn observation_client() -> Option<bollard::Docker> {
    let client = bollard::Docker::connect_with_local_defaults().ok()?;
    client.ping().await.ok()?;
    Some(client)
}

/// Make sure `image` is present, pulling it if needed.
async fn ensure_image(client: &bollard::Docker, image: &str) -> bool {
    if client.inspect_image(image).await.is_ok() {
        return true;
    }
    let options = CreateImageOptions {
        from_image: image,
        ..Default::default()
    };
    let mut pull = client.create_image(Some(options), None, None);
    while let Some(step) = pull.next().await {
        if step.is_err() {
            return false;
        }
    }
    client.inspect_image(image).await.is_ok()
}

/// Start a long-lived container of `image` running `cmd`; return its name.
async fn start_container(client: &bollard::Docker, image: &str, cmd: Vec<&str>) -> Option<String> {
    let name = format!(
        "termihub-mon-fallback-{}-{}",
        std::process::id(),
        image.len()
    );
    let config = Config {
        image: Some(image),
        cmd: Some(cmd),
        ..Default::default()
    };
    let options = CreateContainerOptions {
        name: name.as_str(),
        platform: None,
    };
    client.create_container(Some(options), config).await.ok()?;
    client
        .start_container(&name, None::<StartContainerOptions<String>>)
        .await
        .ok()?;
    Some(name)
}

async fn remove(client: &bollard::Docker, name: &str) {
    let options = RemoveContainerOptions {
        force: true,
        ..Default::default()
    };
    let _ = client.remove_container(name, Some(options)).await;
}

/// Start a container of `image`, open an existing-container session exec-ing
/// `shell`, and return two monitoring samples — or `None` to skip when no
/// usable daemon/image is available.
async fn sample_container(
    image: &str,
    cmd: Vec<&str>,
    shell: &str,
) -> Option<Vec<termihub_core::monitoring::SystemStats>> {
    let Some(client) = observation_client().await else {
        eprintln!("SKIPPED: no reachable container daemon (docker stats fallback, #3202)");
        return None;
    };
    if !ensure_image(&client, image).await {
        eprintln!("SKIPPED: could not pull {image} (docker stats fallback, #3202)");
        return None;
    }
    let Some(name) = start_container(&client, image, cmd).await else {
        eprintln!("SKIPPED: could not start a {image} container (#3202)");
        return None;
    };

    let mut docker = Docker::new();
    let settings = serde_json::json!({
        "containerMode": "existing",
        "existingContainer": name,
        "shell": shell,
    });
    if let Err(e) = docker.connect(settings).await {
        remove(&client, &name).await;
        // Without `DOCKER_HOST`, bollard's local default socket and the Docker
        // CLI context the backend resolves can be different daemons (Podman vs
        // Docker Desktop on macOS): the container then is not found there.
        let msg = e.to_string();
        if msg.contains("not found") {
            eprintln!("SKIPPED: backend reached a different daemon ({msg}); set DOCKER_HOST");
            return None;
        }
        panic!("connect to the {image} container failed: {msg}");
    }

    let provider = docker.monitoring().expect("monitoring provider");
    let subscribed = provider.subscribe().await;
    let mut samples = Vec::new();
    if let Ok(mut sub) = subscribed {
        while samples.len() < 2 {
            match tokio::time::timeout(Duration::from_secs(15), sub.stats.recv()).await {
                Ok(Some(stats)) => samples.push(stats),
                _ => break,
            }
        }
        provider.unsubscribe().await.expect("unsubscribe");
    }
    let _ = docker.disconnect().await;
    remove(&client, &name).await;
    Some(samples)
}

#[tokio::test]
async fn distroless_container_is_monitored_via_docker_stats() {
    let cmd = vec!["-c", "import time; time.sleep(300)"];
    let Some(samples) = sample_container(DISTROLESS, cmd, "/usr/bin/python3").await else {
        return;
    };

    assert_eq!(samples.len(), 2, "expected two docker-stats samples");
    let last = samples.last().expect("sample");
    eprintln!("docker stats fallback sample: {last:?}");
    assert_eq!(last.source, StatsSource::DockerStats);
    assert!(last.memory_total_kb > 0, "memory limit reported");
    assert!(last.memory_used_percent > 0.0, "memory usage reported");
    assert!(last.pids_current.unwrap_or(0) >= 1, "pids reported");
    for metric in [
        StatsMetric::LoadAverage,
        StatsMetric::Uptime,
        StatsMetric::Disk,
        StatsMetric::Processes,
    ] {
        assert!(
            last.is_unavailable(metric),
            "{metric:?} must be unavailable"
        );
    }
    assert!(!last.is_unavailable(StatsMetric::Cpu));
    assert!(!last.is_unavailable(StatsMetric::Memory));
}

/// A `/proc`-capable container keeps the richer `/proc` path.
#[tokio::test]
async fn proc_capable_container_keeps_the_proc_source() {
    let Some(samples) = sample_container(ALPINE, vec!["sleep", "300"], "/bin/sh").await else {
        return;
    };
    assert_eq!(samples.len(), 2, "expected two /proc samples");
    let last = samples.last().expect("sample");
    assert_eq!(last.source, StatsSource::Proc);
    assert!(last.unavailable_metrics.is_empty());
    assert!(last.disk_total_kb > 0, "/proc path reports disk");
}
