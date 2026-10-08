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

use std::path::Path;

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

/// Grant the runner executable, then its folder (the loader searches it). A
/// missing runner surfaces as [`HostError::RunnerUnavailable`], as without the
/// sandbox; a grant the user may not make is tolerated (see the module docs).
fn grant_runner(container: &AppContainer, exec_path: &Path) -> Result<(), HostError> {
    let folder = exec_path.parent().filter(|p| !p.as_os_str().is_empty());
    for path in std::iter::once(exec_path).chain(folder) {
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

/// Delete plugin `plugin_id`'s AppContainer profile (on uninstall); a failure
/// is logged, never fatal.
pub(crate) fn remove_profile(plugin_id: &str) {
    if let Err(e) = termihub_plugin_runner::appcontainer::delete_profile(plugin_id) {
        tracing::warn!(
            target: crate::plugin::PLUGIN_LOG_TARGET,
            "could not delete the AppContainer profile of plugin `{plugin_id}`: {e}"
        );
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
