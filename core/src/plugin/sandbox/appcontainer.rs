//! Windows: prepare one plugin's Less-Privileged AppContainer before its
//! runner starts (#4187, plugin OS-sandbox phase 5b).
//!
//! The runner cannot confine itself on Windows, so the host does it at spawn:
//! the plugin's AppContainer profile is created (or reused), its SID is granted
//! exactly what the runner needs, and the runner is then started inside it
//! (`termihub_plugin_runner::process::RunnerCommand::app_container`):
//!
//! | Path                                   | Access              |
//! | -------------------------------------- | ------------------- |
//! | the runner executable and its folder   | read + execute      |
//! | the plugin's install folder (tree)     | read + execute      |
//! | the plugin's data folder (tree)        | modify              |
//!
//! Nothing else: no user profile, no network, no `HKCU\Software`, no other
//! plugin's folders. The runner's folder entry is the folder itself only (not
//! inherited), so other files there stay closed; the system DLLs are readable
//! to every LPAC by default. A per-machine install the user cannot re-ACL keeps
//! the runner readable through its folder's own "ALL RESTRICTED APPLICATION
//! PACKAGES" entry, so a refused grant there is tolerated.
//!
//! Any other failure is a setup failure: the plugin is not loaded
//! ([`HostError::SandboxSetupFailed`]).
//!
//! On uninstall ([`remove_profile`], #4263) the runner grants are revoked
//! before the profile is deleted, so a runner the user owns ends with the ACL
//! it had before the plugin was first loaded. The plugin's own folders are
//! deleted with it and need nothing.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use termihub_plugin_runner::appcontainer::{AppContainer, MODIFY, READ_EXECUTE};
use termihub_plugin_runner::sandbox::SandboxPolicy;

use crate::plugin::HostError;

/// Create or reuse plugin `plugin_id`'s AppContainer and grant it the runner
/// `exec_path` and the folders of `policy`.
pub(super) fn prepare(
    exec_path: &Path,
    plugin_id: &str,
    policy: &SandboxPolicy,
) -> Result<AppContainer, HostError> {
    let failed = |what: &str, e: &dyn std::fmt::Display| {
        HostError::SandboxSetupFailed(format!("{what}: {e}"))
    };
    policy
        .validate()
        .map_err(|e| HostError::SandboxSetupFailed(e.to_string()))?;
    let container = AppContainer::ensure(plugin_id)
        .map_err(|e| failed("creating the plugin's AppContainer profile", &e))?;
    grant_runner(&container, exec_path)?;
    let install = Path::new(&policy.install_dir);
    container
        .grant_tree(install, READ_EXECUTE)
        .map_err(|e| failed(&format!("granting `{}`", install.display()), &e))?;
    // The data folder exists only for an ABI 1.1 plugin (the host creates it
    // before the spawn); a 1.0 plugin gets no writable folder at all.
    if let Some(data) = policy.data_dir.as_deref().map(Path::new) {
        if data.is_dir() {
            container
                .grant_tree(data, MODIFY)
                .map_err(|e| failed(&format!("granting `{}`", data.display()), &e))?;
        }
    }
    Ok(container)
}

/// Every runner executable this process granted a plugin, so an uninstall
/// revokes the grant from it even when it is not the default runner (a debug
/// override, a test's copy).
static GRANTED_RUNNERS: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

/// The runner executable `exec_path` and its folder: the objects granted to,
/// and revoked from, each plugin's AppContainer.
fn runner_objects(exec_path: &Path) -> impl Iterator<Item = &Path> {
    let folder = exec_path.parent().filter(|p| !p.as_os_str().is_empty());
    std::iter::once(exec_path).chain(folder)
}

/// Grant the runner executable, then its folder (the loader searches it). A
/// missing runner surfaces as [`HostError::RunnerUnavailable`], as without the
/// sandbox; a grant the user may not make is tolerated (see the module docs).
fn grant_runner(container: &AppContainer, exec_path: &Path) -> Result<(), HostError> {
    GRANTED_RUNNERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(exec_path.to_owned());
    for path in runner_objects(exec_path) {
        match container.grant_object(path, READ_EXECUTE) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                tracing::debug!(
                    target: crate::plugin::PLUGIN_LOG_TARGET,
                    "cannot grant the plugin sandbox `{}` ({e}); relying on its existing ACL",
                    path.display()
                );
            }
            Err(e) => {
                return Err(HostError::RunnerUnavailable {
                    path: exec_path.to_owned(),
                    detail: format!("granting the plugin sandbox `{}`: {e}", path.display()),
                })
            }
        }
    }
    Ok(())
}

/// Delete plugin `plugin_id`'s AppContainer profile (on uninstall), revoking
/// its grants on the runner first: the default runner and every runner this
/// process granted, each executable and its folder. A failure is logged, never
/// fatal; a refused revoke (a per-machine install, where the grant was refused
/// too) or a runner that is not there is expected and only logged for debugging.
pub(crate) fn remove_profile(plugin_id: &str) {
    let mut runners = GRANTED_RUNNERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    runners.extend(super::default_runner_path());
    let objects: BTreeSet<&Path> = runners.iter().flat_map(|r| runner_objects(r)).collect();
    let objects: Vec<&Path> = objects.into_iter().collect();
    match termihub_plugin_runner::appcontainer::delete_profile_revoking(plugin_id, &objects) {
        Ok(failures) => {
            for (path, e) in failures {
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::NotFound
                ) {
                    tracing::debug!(
                        target: crate::plugin::PLUGIN_LOG_TARGET,
                        "cannot revoke plugin `{plugin_id}`'s sandbox grant on `{}` ({e}); \
                         leaving its ACL as it is",
                        path.display()
                    );
                } else {
                    tracing::warn!(
                        target: crate::plugin::PLUGIN_LOG_TARGET,
                        "could not revoke plugin `{plugin_id}`'s sandbox grant on `{}`: {e}",
                        path.display()
                    );
                }
            }
        }
        Err(e) => tracing::warn!(
            target: crate::plugin::PLUGIN_LOG_TARGET,
            "could not delete the AppContainer profile of plugin `{plugin_id}`: {e}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_invalid_policy_fails_before_any_profile_is_made() {
        let policy = SandboxPolicy {
            install_dir: "not/absolute".to_owned(),
            ..SandboxPolicy::default()
        };
        match prepare(Path::new(r"C:\runner.exe"), "never-created", &policy) {
            Err(HostError::SandboxSetupFailed(detail)) => {
                assert!(detail.contains("not absolute"), "{detail}");
            }
            other => panic!("expected SandboxSetupFailed, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_runner_is_unavailable_not_a_sandbox_failure() {
        let tmp = tempfile::TempDir::new().unwrap();
        let install = tmp.path().join("install");
        std::fs::create_dir_all(&install).unwrap();
        let policy = SandboxPolicy {
            install_dir: install.to_str().unwrap().to_owned(),
            ..SandboxPolicy::default()
        };
        let id = format!("core-prepare-missing-{}", std::process::id());
        let missing = tmp.path().join("no-such-runner.exe");
        let result = prepare(&missing, &id, &policy);
        remove_profile(&id);
        match result {
            Err(HostError::RunnerUnavailable { path, .. }) => assert_eq!(path, missing),
            other => panic!("expected RunnerUnavailable, got {other:?}"),
        }
    }
}
