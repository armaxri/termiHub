//! Host side of the OS sandbox policy (#4186): derive one plugin's
//! [`SandboxPolicy`] from the host's own paths, and judge the runner's
//! [`SandboxReport`].
//!
//! The policy is built from the plugin's install and data folders only — never
//! from the manifest — so a plugin cannot widen its own confinement. Declared
//! capabilities (network, filesystem paths) are served by the capability
//! bridge in the host (#4183), not by loosening the sandbox: the runner itself
//! has no network and no filesystem access beyond these two folders.

use std::path::Path;

use termihub_plugin_runner::ipc::SandboxReport;
use termihub_plugin_runner::sandbox::{required_layers, Isolation, SandboxPolicy};

use crate::plugin::HostError;

/// Build the policy for a plugin installed in `install_dir` with the private
/// data folder `data_dir` (already created). Paths are canonicalised: the
/// kernel matches resolved paths. The user's home folder is denied explicitly.
pub fn sandbox_policy(
    install_dir: &Path,
    data_dir: Option<&str>,
) -> Result<SandboxPolicy, HostError> {
    let canonical = |path: &Path| -> Result<String, HostError> {
        let resolved = path.canonicalize().map_err(|e| {
            HostError::SandboxSetupFailed(format!(
                "cannot resolve the plugin folder `{}`: {e}",
                path.display()
            ))
        })?;
        resolved.to_str().map(str::to_owned).ok_or_else(|| {
            HostError::SandboxSetupFailed(format!(
                "the plugin folder `{}` is not valid UTF-8",
                resolved.display()
            ))
        })
    };
    let policy = SandboxPolicy {
        install_dir: canonical(install_dir)?,
        data_dir: data_dir.map(|d| canonical(Path::new(d))).transpose()?,
        denied_dirs: crate::config::home_directory()
            .and_then(|home| home.canonicalize().ok())
            .and_then(|home| home.to_str().map(str::to_owned))
            .into_iter()
            .collect(),
    };
    policy
        .validate()
        .map_err(|e| HostError::SandboxSetupFailed(e.to_string()))?;
    Ok(policy)
}

/// Accept or refuse a runner's report for a requested sandbox: a failed setup,
/// or a layer this platform requires that is not enforced, refuses the plugin.
/// Reduced isolation is accepted for now (the `reducedIsolationAccepted`
/// acknowledgement gate is a later phase).
pub(super) fn check_report(report: &SandboxReport) -> Result<(), HostError> {
    if let Some(failed) = &report.failed {
        return Err(HostError::SandboxSetupFailed(failed.clone()));
    }
    if let Some(layer) = report.missing_required(required_layers()) {
        return Err(HostError::SandboxSetupFailed(format!(
            "the runner did not enforce the required `{layer}` layer"
        )));
    }
    if report.isolation() == Isolation::Reduced {
        tracing::warn!(
            target: crate::plugin::PLUGIN_LOG_TARGET,
            "plugin runner reports reduced isolation, missing: {}",
            report.missing.join(", ")
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_plugin_runner::sandbox::layer;

    #[test]
    fn the_policy_is_canonical_and_denies_home() {
        let tmp = tempfile::TempDir::new().unwrap();
        let install = tmp.path().join("acme");
        let data = tmp.path().join(".data").join("acme");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let policy = sandbox_policy(&install, data.to_str()).unwrap();
        let canonical = |p: &Path| p.canonicalize().unwrap().to_str().unwrap().to_owned();
        assert_eq!(policy.install_dir, canonical(&install));
        assert_eq!(policy.data_dir, Some(canonical(&data)));
        if let Some(home) = crate::config::home_directory().and_then(|h| h.canonicalize().ok()) {
            assert_eq!(policy.denied_dirs, vec![home.to_str().unwrap().to_owned()]);
        }
    }

    #[test]
    fn a_missing_folder_fails_closed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let missing = tmp.path().join("absent");
        assert!(matches!(
            sandbox_policy(&missing, None),
            Err(HostError::SandboxSetupFailed(_))
        ));
    }

    #[test]
    fn a_failed_or_incomplete_report_is_refused() {
        let failed = SandboxReport {
            failed: Some("denied by the kernel".into()),
            ..SandboxReport::default()
        };
        assert!(matches!(
            check_report(&failed),
            Err(HostError::SandboxSetupFailed(m)) if m.contains("denied by the kernel")
        ));
        let full = SandboxReport::enforced(required_layers());
        assert!(check_report(&full).is_ok());
        let nothing = SandboxReport::default();
        assert_eq!(
            check_report(&nothing).is_err(),
            !required_layers().is_empty()
        );
        let reduced = SandboxReport {
            missing: vec![layer::LANDLOCK.into()],
            ..SandboxReport::enforced(required_layers())
        };
        // Reduced is not refused here (the acknowledgement gate is later),
        // as long as every required layer is enforced.
        assert!(check_report(&reduced).is_ok());
    }
}
