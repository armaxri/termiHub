//! Windows: a native plugin loads in its Less-Privileged AppContainer through
//! the runner of a **per-machine install**, as a **standard user** (#4252).
//!
//! The host grants each plugin's AppContainer SID read + execute on the runner
//! executable and its folder (`core/src/plugin/sandbox/appcontainer.rs`). In
//! `C:\Program Files\termiHub` a standard user may not rewrite that ACL, so the
//! grant is refused and the runner must stay startable through the folder's
//! inherited "ALL RESTRICTED APPLICATION PACKAGES" read + execute entry. The
//! other sandbox tests cannot see this: they run the runner from a cargo target
//! dir the test user owns, where the grant always succeeds.
//!
//! This test is the harness of the Windows release smoke
//! (`.github/workflows/release-windows-smoke.yml`, job
//! `windows-per-machine-plugin-lpac`). It is ignored by default and needs the
//! environment that job prepares through
//! `scripts/internal/verify-plugin-lpac-per-machine.ps1`:
//!
//! * `TERMIHUB_INSTALLED_RUNNER` — the runner the MSI installed, and
//! * `TERMIHUB_ECHO_BACKEND_LIB` — a prebuilt `echo_backend.dll`,
//!
//! with the test binary started as a non-administrator local user. It then
//! asserts the precondition (this user cannot change the runner's ACL, so the
//! host's grant really is refused), loads the real `echo-backend` example
//! through that runner, requires the full Windows confinement (AppContainer +
//! job object) and round-trips data through a session.
#![cfg(all(windows, feature = "plugin"))]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

mod plugin_runner_support;
use plugin_runner_support::{install_plugin, new_connection};

use termihub_core::connection::ConnectionTypeRegistry;
use termihub_core::plugin::sandbox::{layer, Isolation, PluginRunnerConfig};
use termihub_core::plugin::PluginHost;

/// The installed runner (`C:\Program Files\termiHub\termihub-plugin-runner.exe`).
const RUNNER_ENV: &str = "TERMIHUB_INSTALLED_RUNNER";
/// A prebuilt echo-backend library (the test user cannot run cargo).
const ECHO_LIB_ENV: &str = "TERMIHUB_ECHO_BACKEND_LIB";

const WAIT: Duration = Duration::from_secs(15);

/// `WRITE_DAC`: the right the host's grant needs on the runner and its folder.
const WRITE_DAC: u32 = 0x0004_0000;
/// `FILE_FLAG_BACKUP_SEMANTICS`: needed to open a directory handle.
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

fn required_path(var: &str) -> PathBuf {
    let path = std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("set {var} (see the module docs)"));
    assert!(path.is_file(), "{var} = `{}` is not a file", path.display());
    path
}

/// Whether this process may rewrite `path`'s DACL. Opening with `WRITE_DAC`
/// is exactly the access check the host's `SetNamedSecurityInfoW` grant hits.
fn can_write_dac(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    match std::fs::OpenOptions::new()
        .access_mode(WRITE_DAC)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
    {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => false,
        Err(e) => panic!("open `{}` for WRITE_DAC: {e}", path.display()),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a per-machine install and a standard user (release-windows-smoke.yml)"]
async fn echo_backend_loads_in_its_lpac_from_a_per_machine_install() {
    let runner = required_path(RUNNER_ENV);
    let echo_lib = required_path(ECHO_LIB_ENV);
    let folder = runner.parent().expect("the runner sits in a folder");

    // The precondition this test exists for: the host's grant on the runner
    // and its folder is refused, so only the install's inherited ACL can let
    // the AppContainer start it.
    for path in [runner.as_path(), folder] {
        assert!(
            !can_write_dac(path),
            "this user may rewrite the ACL of `{}`: run the test as a standard user \
             against a per-machine install",
            path.display()
        );
    }

    let work = tempfile::TempDir::new().unwrap();
    let manifest = include_str!("../../examples/plugins/echo-backend/manifest.json");
    let echo = install_plugin(work.path(), &echo_lib, manifest);
    let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
    let host = PluginHost::new(&echo.root, Arc::clone(&registry))
        .with_runner(PluginRunnerConfig::new(runner.clone()));
    let id = echo.plugin.manifest.id.clone();
    host.load(&echo.plugin)
        .unwrap_or_else(|e| panic!("the installed runner loads echo-backend: {e}"));

    let handle = host.sandboxed_plugin(&id).expect("loaded out of process");
    let running = handle.running().expect("a running runner");
    let report = running.sandbox_report().clone();
    println!("installed runner: {}", runner.display());
    println!("sandbox report: {report:?}");
    assert_eq!(report.isolation(), Isolation::Full, "{report:?}");
    for required in [layer::APPCONTAINER, layer::JOB_OBJECT] {
        assert!(
            report.enforced.iter().any(|l| l == required),
            "`{required}` is not enforced: {report:?}"
        );
    }
    assert_ne!(running.pid(), Some(std::process::id()));

    let mut conn = new_connection(&registry, &echo.type_id);
    let mut rx = conn.subscribe_output();
    conn.connect(serde_json::json!({ "echoPrefix": "lpac> " }))
        .await
        .expect("the session starts in the confined runner");
    conn.write(b"per-machine").unwrap();
    let chunk = tokio::time::timeout(WAIT, rx.recv())
        .await
        .expect("echo within the timeout")
        .expect("an output chunk");
    assert_eq!(String::from_utf8(chunk).unwrap(), "lpac> per-machine");
    conn.disconnect().await.unwrap();

    host.unload(&id);
    // Leave no profile behind for this user (best effort; the CI user is
    // deleted with the runner anyway).
    let _ = termihub_plugin_runner::appcontainer::delete_profile(&id);
}
