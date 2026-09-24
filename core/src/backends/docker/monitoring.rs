//! Docker container monitoring (#3182).
//!
//! A container is Linux with `/proc`, so its system stats are gathered exactly
//! like the SSH backend's — running the canonical
//! [`MONITORING_COMMAND`](crate::monitoring::MONITORING_COMMAND) and feeding the
//! output through the shared [`parse_stats`](crate::monitoring::parse_stats)
//! parser. The only Docker-specific part is *how* the command runs: a single
//! `docker exec` via bollard, reading `/proc/stat`, `/proc/meminfo`,
//! `/proc/net/dev`, etc. in one round-trip. Everything else — the collect loop,
//! the CPU/network delta trackers, the observable lifecycle — is provided by the
//! shared [`ExecMonitoringProvider`](crate::monitoring::ExecMonitoringProvider).

use std::sync::Arc;

use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use futures_util::StreamExt;

use crate::errors::CoreError;
use crate::monitoring::{ExecMonitoringProvider, ProcStatsSource, MONITORING_COMMAND};

/// A [`ProcStatsSource`] that runs the monitoring command inside a Docker
/// container via `docker exec`.
struct DockerProcStatsSource {
    client: bollard::Docker,
    container_id: String,
}

#[async_trait::async_trait]
impl ProcStatsSource for DockerProcStatsSource {
    async fn collect_proc(&self) -> Result<String, CoreError> {
        exec_monitoring_command(&self.client, &self.container_id).await
    }
}

/// Build the Docker monitoring provider for a connected container.
///
/// Called from [`Docker::connect`](super::Docker) with a clone of the live
/// bollard client and the container id, mirroring how the file browser is wired.
pub(super) fn docker_monitoring_provider(
    client: bollard::Docker,
    container_id: String,
) -> ExecMonitoringProvider {
    ExecMonitoringProvider::new(Arc::new(DockerProcStatsSource {
        client,
        container_id,
    }))
}

/// Run [`MONITORING_COMMAND`] inside the container in a single exec and return
/// its raw stdout.
///
/// The command is wrapped in `sh -c` so the whole compound pipeline (which
/// `export`s a C locale itself) runs in one shell. As with the SSH exec, the
/// process exit status is intentionally ignored: [`parse_stats`] tolerates a
/// missing trailing leg (e.g. a container without `/proc/net/dev`), so returning
/// whatever stdout was produced yields more metrics than failing the collect on
/// a non-zero exit. A container with no shell / no readable `/proc` (distroless)
/// produces stdout the parser rejects, which the provider surfaces honestly as a
/// failed connect — never fabricated data.
async fn exec_monitoring_command(
    client: &bollard::Docker,
    container_id: &str,
) -> Result<String, CoreError> {
    let exec_config = CreateExecOptions {
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        cmd: Some(vec!["sh", "-c", MONITORING_COMMAND]),
        ..Default::default()
    };

    let exec = client
        .create_exec(container_id, exec_config)
        .await
        .map_err(|e| CoreError::Other(format!("failed to create monitoring exec: {e}")))?;

    let start_config = StartExecOptions {
        detach: false,
        ..Default::default()
    };

    let result = client
        .start_exec(&exec.id, Some(start_config))
        .await
        .map_err(|e| CoreError::Other(format!("failed to start monitoring exec: {e}")))?;

    match result {
        StartExecResults::Attached { mut output, .. } => {
            let mut stdout = Vec::new();
            while let Some(chunk) = output.next().await {
                match chunk {
                    Ok(bollard::container::LogOutput::StdOut { message }) => {
                        stdout.extend_from_slice(&message);
                    }
                    // stderr is ignored — the parser reads stdout, and a partial
                    // leg's diagnostic on stderr must not fail the whole collect.
                    Ok(_) => {}
                    Err(e) => {
                        return Err(CoreError::Other(format!(
                            "monitoring exec output error: {e}"
                        )));
                    }
                }
            }
            Ok(String::from_utf8_lossy(&stdout).to_string())
        }
        StartExecResults::Detached => Err(CoreError::Other(
            "monitoring exec started in detached mode".to_string(),
        )),
    }
}
