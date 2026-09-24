//! Docker container process listing + termination (PROD-0028).
//!
//! A container is Linux with `/proc`, so its process table and kills are
//! gathered exactly like the SSH backend's — running `ps` / `kill` and parsing
//! the output. The Docker-specific part is the transport: a single `docker exec`
//! per operation via bollard. Parsing, signal mapping, and kill-result
//! classification come from the shared
//! [`ExecProcessManager`](crate::monitoring::ExecProcessManager).

use std::sync::Arc;

use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use futures_util::StreamExt;

use crate::errors::CoreError;
use crate::monitoring::{ExecProcessManager, ProcessCommandOutput, ProcessExecSource};

/// A [`ProcessExecSource`] that runs commands inside a container via `docker exec`.
struct DockerProcessExecSource {
    client: bollard::Docker,
    container_id: String,
}

#[async_trait::async_trait]
impl ProcessExecSource for DockerProcessExecSource {
    async fn exec(&self, command: &str) -> Result<ProcessCommandOutput, CoreError> {
        exec_capture(&self.client, &self.container_id, command).await
    }
}

/// Build the Docker process manager for a connected container.
pub(super) fn docker_process_manager(
    client: bollard::Docker,
    container_id: String,
) -> ExecProcessManager {
    ExecProcessManager::new(Arc::new(DockerProcessExecSource {
        client,
        container_id,
    }))
}

/// Run `command` in the container via a single `docker exec` and capture stdout,
/// stderr, and the exit status.
///
/// Unlike the monitoring exec (which needs only stdout), a `kill` must know
/// whether it succeeded, so stderr and the exit code are captured too — the exit
/// code is read from `inspect_exec` after the output stream drains.
async fn exec_capture(
    client: &bollard::Docker,
    container_id: &str,
    command: &str,
) -> Result<ProcessCommandOutput, CoreError> {
    let exec_config = CreateExecOptions {
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        cmd: Some(vec!["sh", "-c", command]),
        ..Default::default()
    };

    let exec = client
        .create_exec(container_id, exec_config)
        .await
        .map_err(|e| CoreError::Other(format!("failed to create process exec: {e}")))?;

    let start_config = StartExecOptions {
        detach: false,
        ..Default::default()
    };

    let result = client
        .start_exec(&exec.id, Some(start_config))
        .await
        .map_err(|e| CoreError::Other(format!("failed to start process exec: {e}")))?;

    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    match result {
        StartExecResults::Attached { mut output, .. } => {
            while let Some(chunk) = output.next().await {
                match chunk {
                    Ok(bollard::container::LogOutput::StdOut { message }) => {
                        stdout.extend_from_slice(&message)
                    }
                    Ok(bollard::container::LogOutput::StdErr { message }) => {
                        stderr.extend_from_slice(&message)
                    }
                    Ok(_) => {}
                    Err(e) => {
                        return Err(CoreError::Other(format!("process exec output error: {e}")))
                    }
                }
            }
        }
        StartExecResults::Detached => {
            return Err(CoreError::Other(
                "process exec started in detached mode".to_string(),
            ))
        }
    }

    // The exit code is available only after the stream drains.
    let exit_status = client
        .inspect_exec(&exec.id)
        .await
        .ok()
        .and_then(|inspect| inspect.exit_code)
        .map(|code| code as i32);

    Ok(ProcessCommandOutput {
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        exit_status,
    })
}
