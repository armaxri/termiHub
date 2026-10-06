//! Shared support for the out-of-process plugin tests (#4182): builds the
//! `termihub-plugin-runner` binary and the real `echo-backend` example plugin,
//! and installs + trusts the plugin under a temporary plugins root.
//!
//! Both are built into their own target directories under cargo's
//! per-package scratch dir (`CARGO_TARGET_TMPDIR`), like the test-plugin
//! fixture: the outer `cargo test` holds the workspace build-directory lock, so
//! building into the workspace target dir from inside a test would deadlock.
//! The build profile follows the test binary's (a `--release` perf run builds
//! release artifacts).
#![allow(
    dead_code,
    reason = "shared test-support module: each test binary uses a different subset"
)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use termihub_core::connection::{plugin_type_id, ConnectionType, ConnectionTypeRegistry};
use termihub_core::plugin::{
    native_library_hash, pack_plugin, InstalledPlugin, NativeTrustStore, PluginHost, PluginManager,
};

/// The workspace root (core's parent).
pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("core sits inside the workspace")
        .to_path_buf()
}

fn profile_args() -> (&'static [&'static str], &'static str) {
    if cfg!(debug_assertions) {
        (&[], "debug")
    } else {
        (&["--release"], "release")
    }
}

/// Build a workspace package into a private target dir; return its output dir.
fn build_package(package: &str) -> PathBuf {
    let (args, profile) = profile_args();
    let target_dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("{package}-{profile}"));
    let status = Command::new(env!("CARGO"))
        .current_dir(workspace_root())
        .args(["build", "-p", package, "--target-dir"])
        .arg(&target_dir)
        .args(args)
        .status()
        .expect("spawn cargo");
    assert!(status.success(), "building {package} failed");
    target_dir.join(profile)
}

/// The runner binary (`TERMIHUB_PLUGIN_RUNNER` overrides the build).
pub fn runner_binary() -> PathBuf {
    static BUILT: OnceLock<PathBuf> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            if let Some(path) = std::env::var_os("TERMIHUB_PLUGIN_RUNNER") {
                return PathBuf::from(path);
            }
            build_package("termihub-plugin-runner").join(format!(
                "termihub-plugin-runner{}",
                std::env::consts::EXE_SUFFIX
            ))
        })
        .clone()
}

/// The echo-backend example library, freshly copied under `work`.
pub fn echo_backend_library(work: &Path) -> PathBuf {
    static BUILT: OnceLock<PathBuf> = OnceLock::new();
    let src = BUILT.get_or_init(|| {
        build_package("echo-backend").join(format!(
            "{}echo_backend{}",
            std::env::consts::DLL_PREFIX,
            std::env::consts::DLL_SUFFIX
        ))
    });
    let dir = work.join("echo-lib");
    std::fs::create_dir_all(&dir).unwrap();
    let dest = dir.join(src.file_name().unwrap());
    std::fs::copy(src, &dest).expect("copy the echo-backend library");
    dest
}

/// An installed + trusted echo-backend plugin under `<work>/plugins`.
pub struct InstalledEcho {
    pub root: PathBuf,
    pub plugin: InstalledPlugin,
    pub type_id: String,
}

/// Package the real echo-backend example, install it through the manager and
/// acknowledge it in the native trust store.
pub fn install_echo(work: &Path) -> InstalledEcho {
    let lib = echo_backend_library(work);
    let manifest = std::fs::read_to_string(
        workspace_root().join("examples/plugins/echo-backend/manifest.json"),
    )
    .unwrap();
    install_plugin(work, &lib, &manifest)
}

/// Package `lib` with `manifest`, install it through the manager and
/// acknowledge it in the native trust store.
pub fn install_plugin(work: &Path, lib: &Path, manifest: &str) -> InstalledEcho {
    install_plugin_tagged(work, "", lib, manifest)
}

/// [`install_plugin`] with its own source and package dirs (`tag`), so
/// several plugins can be installed under the same `<work>/plugins` root.
pub fn install_plugin_tagged(work: &Path, tag: &str, lib: &Path, manifest: &str) -> InstalledEcho {
    let src = work.join(format!("plugin-src{tag}"));
    let backend = src.join("backend");
    std::fs::create_dir_all(&backend).unwrap();
    std::fs::copy(lib, backend.join(lib.file_name().unwrap())).unwrap();
    std::fs::write(src.join("manifest.json"), manifest).unwrap();
    let package = pack_plugin(&src, &work.join(format!("dist{tag}"))).expect("pack the plugin");

    let root = work.join("plugins");
    let manager = PluginManager::new(&root);
    let plugin = manager
        .install(&package, true, false)
        .expect("install the plugin");
    let id = plugin.manifest.id.clone();
    let hash = native_library_hash(&root, &id).expect("hash the library");
    let mut trust = NativeTrustStore::load(&root);
    trust.set_native_enabled(true).unwrap();
    trust.acknowledge(&id, hash).unwrap();
    let connection_type = plugin
        .manifest
        .extensions
        .terminal_backend
        .as_ref()
        .expect("the plugin declares a terminal backend")
        .connection_type
        .clone();
    InstalledEcho {
        type_id: plugin_type_id(&id, &connection_type),
        root,
        plugin,
    }
}

/// A host over `echo`'s root sharing a fresh registry.
pub fn host_for(echo: &InstalledEcho) -> (PluginHost, Arc<Mutex<ConnectionTypeRegistry>>) {
    let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
    (PluginHost::new(&echo.root, Arc::clone(&registry)), registry)
}

/// Create an unconnected session of `type_id`.
pub fn new_connection(
    registry: &Arc<Mutex<ConnectionTypeRegistry>>,
    type_id: &str,
) -> Box<dyn ConnectionType> {
    registry
        .lock()
        .unwrap()
        .create(type_id)
        .expect("the plugin's type is registered")
}

/// Whether process `pid` still exists (Unix).
#[cfg(unix)]
pub fn process_exists(pid: u32) -> bool {
    let pid = i32::try_from(pid).expect("pid fits");
    // SAFETY: signal 0 only checks for existence/permission.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// SIGKILL `pid` (Unix).
#[cfg(unix)]
pub fn kill_process(pid: u32) {
    let pid = i32::try_from(pid).expect("pid fits");
    // SAFETY: plain `kill(2)` on a child pid this test owns.
    unsafe { libc::kill(pid, libc::SIGKILL) };
}

/// Poll `cond` every 10 ms for up to `timeout`.
pub fn wait_until(timeout: std::time::Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    cond()
}
