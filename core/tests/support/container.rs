//! Shared helpers for the live container-runtime integration tests (#3888).
//!
//! ## Observe through the backend's own endpoint resolution
//!
//! On a host with several container runtimes the daemons diverge: the Docker
//! backend follows `DOCKER_HOST`, else the active **Docker CLI context** (e.g.
//! Docker Desktop's `desktop-linux`), while a bare
//! `bollard::Docker::connect_with_local_defaults()` only reads `DOCKER_HOST`
//! and then `/var/run/docker.sock` — which `podman-mac-helper` points at the
//! Podman machine. A test that observed through its own client therefore
//! looked at a different daemon from the one the session spawned into, never
//! saw its container, and leaked it.
//!
//! [`runtime_client`] calls the backend's
//! [`connect_to_runtime`](termihub_core::backends::docker::connect_to_runtime),
//! so the test and the backend reach the same daemon by construction.
//!
//! ## Guaranteed cleanup
//!
//! [`CleanupGuard`] removes its containers and scratch directories when it is
//! dropped — including while a failed assertion unwinds the test.

use std::path::PathBuf;

use bollard::container::RemoveContainerOptions;
use termihub_core::backends::docker::connect_to_runtime;
use termihub_core::config::ContainerRuntime;

/// Connect to the daemon a session with `runtime: auto` (the default) reaches,
/// and prove it answers. `None` means the backend could not work here either,
/// so the caller should skip.
pub async fn runtime_client() -> Option<bollard::Docker> {
    let client = connect_to_runtime(&ContainerRuntime::Auto).await.ok()?;
    client.ping().await.ok()?;
    Some(client)
}

/// Force-removes the registered containers and deletes the registered
/// directories on drop, so a panicking test leaks neither.
#[derive(Default)]
pub struct CleanupGuard {
    containers: Vec<String>,
    dirs: Vec<PathBuf>,
}

impl CleanupGuard {
    /// Remove the container with this id or name on drop.
    pub fn container(&mut self, id_or_name: impl Into<String>) {
        self.containers.push(id_or_name.into());
    }

    /// Delete this directory (recursively) on drop.
    pub fn dir(&mut self, path: impl Into<PathBuf>) {
        self.dirs.push(path.into());
    }
}

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        for dir in &self.dirs {
            let _ = std::fs::remove_dir_all(dir);
        }
        if self.containers.is_empty() {
            return;
        }
        // `Drop` cannot await, and blocking the test's own tokio runtime from
        // inside it would panic. Run the removal on a fresh runtime on its own
        // thread and wait for it, with a fresh client resolved the same way the
        // backend resolves its daemon.
        let containers = std::mem::take(&mut self.containers);
        let removal = std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            rt.block_on(async {
                let Ok(client) = connect_to_runtime(&ContainerRuntime::Auto).await else {
                    return;
                };
                for container in &containers {
                    let options = RemoveContainerOptions {
                        force: true,
                        ..Default::default()
                    };
                    let _ = client.remove_container(container, Some(options)).await;
                }
            });
        });
        let _ = removal.join();
    }
}
