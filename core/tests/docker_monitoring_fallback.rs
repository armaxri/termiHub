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
//! container. Requires a reachable daemon — resolved through the backend's own
//! `connect_to_runtime`, so the fixture container lands on the daemon the
//! session reaches (see `support/container.rs`, #3888) — and pulls the image on
//! first run. Skips gracefully when either is unavailable, so it is safe in CI
//! without Docker. The fixture container is removed even when an assertion
//! panics.

mod support;

use std::time::Duration;

use bollard::container::{Config, CreateContainerOptions, StartContainerOptions};
use bollard::image::CreateImageOptions;
use futures_util::StreamExt;
use support::container::{docker_missing, runtime_client, CleanupGuard};
use termihub_core::backends::docker::Docker;
use termihub_core::connection::ConnectionType;
use termihub_core::monitoring::{StatsMetric, StatsSource};

const DISTROLESS: &str = "gcr.io/distroless/python3-debian12:latest";
const ALPINE: &str = "alpine:3";

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
/// The name is registered with `cleanup` before creation, so even a
/// created-but-not-started container is removed.
async fn start_container(
    client: &bollard::Docker,
    cleanup: &mut CleanupGuard,
    image: &str,
    cmd: Vec<&str>,
) -> Option<String> {
    let name = format!(
        "termihub-mon-fallback-{}-{}",
        std::process::id(),
        image.len()
    );
    cleanup.container(&name);
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

/// Start a container of `image`, open an existing-container session exec-ing
/// `shell`, and return two monitoring samples — or `None` to skip when no
/// usable daemon/image is available.
async fn sample_container(
    image: &str,
    cmd: Vec<&str>,
    shell: &str,
) -> Option<Vec<termihub_core::monitoring::SystemStats>> {
    let Some(client) = runtime_client().await else {
        docker_missing("no reachable container daemon (docker stats fallback, #3202)");
        return None;
    };
    if !ensure_image(&client, image).await {
        docker_missing(&format!(
            "could not pull {image} (docker stats fallback, #3202)"
        ));
        return None;
    }
    let mut cleanup = CleanupGuard::default();
    let Some(name) = start_container(&client, &mut cleanup, image, cmd).await else {
        docker_missing(&format!("could not start a {image} container (#3202)"));
        return None;
    };

    let mut docker = Docker::new();
    let settings = serde_json::json!({
        "containerMode": "existing",
        "existingContainer": name,
        "shell": shell,
    });
    // The fixture container and the session share one endpoint resolution, so
    // a failure here is real (no more "backend reached a different daemon").
    if let Err(e) = docker.connect(settings).await {
        panic!("connect to the {image} container failed: {e}");
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
    drop(cleanup);
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
