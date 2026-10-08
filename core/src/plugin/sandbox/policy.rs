//! Host side of the OS sandbox policy (#4186): derive one plugin's
//! [`SandboxPolicy`] from the host's own paths, and judge the runner's
//! [`SandboxReport`].
//!
//! The policy is built from the plugin's install and data folders only — never
//! from the manifest — so a plugin cannot widen its own confinement. Declared
//! capabilities (network, filesystem paths) are served by the capability
//! bridge in the host (#4183), not by loosening the sandbox: the runner itself
//! has no network and no filesystem access beyond these two folders.

use std::path::{Path, PathBuf};

use termihub_plugin_runner::ipc::SandboxReport;
use termihub_plugin_runner::sandbox::{
    required_layers, Isolation, SandboxPolicy, SIMULATE_MISSING_ENV,
};

use crate::plugin::host_context::PLUGIN_DATA_DIR_NAME;
use crate::plugin::HostError;

/// Build the policy for plugin `id` under `plugins_root`: its install folder
/// `<root>/<id>` read-only and its private data folder `<root>/.data/<id>`
/// read/write. Paths are canonicalised (the kernel matches resolved paths).
/// The user's home folder is denied explicitly.
///
/// The data folder is **not created** here: the host creates it after the
/// load, and only for an ABI 1.1 plugin (whose ABI is known only then); an
/// ABI 1.0 plugin keeps having none, and so nothing it can write.
pub fn sandbox_policy(plugins_root: &Path, id: &str) -> Result<SandboxPolicy, HostError> {
    let failed = |path: &Path, e: &dyn std::fmt::Display| {
        HostError::SandboxSetupFailed(format!(
            "cannot resolve the plugin folder `{}`: {e}",
            path.display()
        ))
    };
    let canonical = |path: &Path| path.canonicalize().map_err(|e| failed(path, &e));
    let utf8 = |path: PathBuf| {
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| failed(&path, &"not valid UTF-8"))
    };
    let root = canonical(plugins_root)?;
    let policy = SandboxPolicy {
        install_dir: utf8(canonical(&plugins_root.join(id))?)?,
        data_dir: Some(utf8(root.join(PLUGIN_DATA_DIR_NAME).join(id))?),
        denied_dirs: crate::config::home_directory()
            .and_then(|home| home.canonicalize().ok())
            .and_then(|home| home.to_str().map(str::to_owned))
            .into_iter()
            .collect(),
        simulate_missing: simulate_missing(),
    };
    policy
        .validate()
        .map_err(|e| HostError::SandboxSetupFailed(e.to_string()))?;
    Ok(policy)
}

/// Debug builds only: the layers [`SIMULATE_MISSING_ENV`] asks the runner to
/// treat as unavailable (comma-separated), to exercise the reduced-isolation
/// path on any kernel. Always empty in a release build.
fn simulate_missing() -> Vec<String> {
    if !cfg!(debug_assertions) {
        return Vec::new();
    }
    parse_simulate_missing(std::env::var(SIMULATE_MISSING_ENV).ok().as_deref())
}

fn parse_simulate_missing(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|layer| !layer.is_empty())
        .map(str::to_owned)
        .collect()
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
        let root = tmp.path().join("plugins");
        std::fs::create_dir_all(root.join("acme")).unwrap();
        let policy = sandbox_policy(&root, "acme").unwrap();
        let canonical = root.canonicalize().unwrap();
        let expect = |p: PathBuf| p.to_str().unwrap().to_owned();
        assert_eq!(policy.install_dir, expect(canonical.join("acme")));
        assert_eq!(
            policy.data_dir,
            Some(expect(canonical.join(PLUGIN_DATA_DIR_NAME).join("acme")))
        );
        assert!(
            !root.join(PLUGIN_DATA_DIR_NAME).exists(),
            "the data folder is created by the host only for a 1.1 plugin"
        );
        if let Some(home) = crate::config::home_directory().and_then(|h| h.canonicalize().ok()) {
            assert_eq!(policy.denied_dirs, vec![home.to_str().unwrap().to_owned()]);
        }
    }

    #[test]
    fn the_simulate_missing_flag_is_a_trimmed_list() {
        assert!(parse_simulate_missing(None).is_empty());
        assert!(parse_simulate_missing(Some(" , ")).is_empty());
        assert_eq!(
            parse_simulate_missing(Some(" landlock, seccomp ")),
            vec![layer::LANDLOCK.to_owned(), layer::SECCOMP.to_owned()]
        );
    }

    #[test]
    fn a_missing_install_folder_fails_closed() {
        let tmp = tempfile::TempDir::new().unwrap();
        assert!(matches!(
            sandbox_policy(tmp.path(), "absent"),
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
