//! In-app update install (#5758).
//!
//! The update *check* (`commands::update`) reads the GitHub release feed and
//! says whether a newer build exists. This module decides how that build can be
//! installed on this machine and, where it can be installed in place, does it
//! with Tauri's updater plugin:
//!
//! * The plugin reads the signed `latest.json` of the latest release, downloads
//!   the bundle for this install's updater target and verifies its minisign
//!   signature against the public key in the release config
//!   (`src-tauri/tauri.updater.conf.json`, merged only into release builds). The
//!   signature also binds the version (`requireSignedVersion`).
//! * Where the in-place update does not apply — no updater key in this build, a
//!   develop build, a `.deb`/`.rpm` install, a portable copy, an isolated
//!   dev/test instance on Windows — the app keeps today's "open the downloads
//!   page" behaviour, and [`UpdateInstallRoute`] says why.
//!
//! Two user clicks, never automatic: [`download_app_update`] downloads and
//! verifies the update, [`install_app_update_and_restart`] installs it and
//! restarts. macOS and Linux relaunch through [`crate::utils::relaunch`], which
//! keeps the instance's environment; on Windows the installer restarts the app.
//!
//! The decisions are pure functions over an [`InstallContext`], so they are unit
//! tested without a Tauri runtime.

use std::sync::Mutex;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tracing::{info, warn};

use super::update_develop::UpdateChannel;

/// Event carrying download progress of an in-app update.
pub const DOWNLOAD_PROGRESS_EVENT: &str = "app-update-download-progress";

/// Updater targets this project publishes in `latest.json`, in the plugin's
/// `{os}-{arch}-{installer}` form. Mirrors `scripts/internal/updater-platforms.json`
/// (a unit test pins the two together). Anything else keeps the downloads page.
pub const PUBLISHED_TARGETS: &[&str] = &[
    "darwin-x86_64-app",
    "darwin-aarch64-app",
    "windows-x86_64-msi",
    "linux-x86_64-appimage",
];

/// How an available update can be installed on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum UpdateInstallMethod {
    /// Open the release page and install the download by hand.
    #[default]
    ReleasePage,
    /// Download, verify and install in place, then restart.
    InApp,
}

/// Why an update is installed from the release page instead of in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum ReleasePageReason {
    /// Develop builds (and builds that do not check) are not updated in place.
    NotStableChannel,
    /// This build carries no updater public key (the signing key is not set up
    /// yet, or this is not a release build).
    NoUpdaterKey,
    /// Installed from a `.deb` or `.rpm`: the package manager owns the files.
    PackageManager,
    /// A portable copy: it is replaced by hand.
    Portable,
    /// A dev or test instance on an isolated profile, whose Windows installer
    /// restart would come back on the default profile.
    IsolatedInstance,
    /// This install type or architecture has no published in-app update.
    UnsupportedInstall,
}

/// The kind of bundle this app was installed from (Tauri's bundle type).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    /// macOS `.app` (also when it came from the `.dmg`).
    App,
    /// Linux AppImage.
    AppImage,
    /// Windows MSI.
    Msi,
    /// Windows NSIS installer.
    Nsis,
    /// Linux `.deb`.
    Deb,
    /// Linux `.rpm`.
    Rpm,
}

impl InstallKind {
    /// The installer name the updater plugin appends to its target.
    fn installer_name(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::AppImage => "appimage",
            Self::Msi => "msi",
            Self::Nsis => "nsis",
            Self::Deb => "deb",
            Self::Rpm => "rpm",
        }
    }

    /// Map Tauri's embedded bundle type. `Dmg` never reaches a running app
    /// (the binary inside the image is the `.app`'s), but maps to `App`.
    pub fn from_bundle_type(bundle: tauri::utils::config::BundleType) -> Self {
        use tauri::utils::config::BundleType;
        match bundle {
            BundleType::App | BundleType::Dmg => Self::App,
            BundleType::AppImage => Self::AppImage,
            BundleType::Msi => Self::Msi,
            BundleType::Nsis => Self::Nsis,
            BundleType::Deb => Self::Deb,
            BundleType::Rpm => Self::Rpm,
        }
    }
}

/// Everything the install decision depends on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallContext {
    /// The feed this build checks.
    pub channel: UpdateChannel,
    /// Whether the release config gave this build an updater public key.
    pub updater_configured: bool,
    /// The bundle this app was installed from, if Tauri knows it.
    pub install_kind: Option<InstallKind>,
    /// Whether this is a portable copy.
    pub portable: bool,
    /// The `TERMIHUB_*` identity variables of this instance (dev/test profile).
    pub identity_vars: Vec<String>,
    /// `std::env::consts::OS` (`macos`, `windows`, `linux`).
    pub os: String,
    /// `std::env::consts::ARCH` (`x86_64`, `aarch64`, …).
    pub arch: String,
}

/// The decision for one install: the updater target to install in place, or
/// the reason to open the release page instead.
pub type UpdateInstallRoute = Result<String, ReleasePageReason>;

/// The updater plugin's OS name for `std::env::consts::OS`.
fn updater_os(os: &str) -> &str {
    match os {
        "macos" => "darwin",
        other => other,
    }
}

/// Decide how an update is installed on this machine.
///
/// The order matters only for which reason is reported: channel, key, portable
/// copy, package type, isolated instance, then whether this target is published.
pub fn install_route(ctx: &InstallContext) -> UpdateInstallRoute {
    if ctx.channel != UpdateChannel::Stable {
        return Err(ReleasePageReason::NotStableChannel);
    }
    if !ctx.updater_configured {
        return Err(ReleasePageReason::NoUpdaterKey);
    }
    if ctx.portable {
        return Err(ReleasePageReason::Portable);
    }
    let kind = match ctx.install_kind {
        Some(InstallKind::Deb | InstallKind::Rpm) => {
            return Err(ReleasePageReason::PackageManager)
        }
        Some(kind) => kind,
        None => return Err(ReleasePageReason::UnsupportedInstall),
    };
    // The Windows installer restarts the app itself, without this process's
    // environment: an isolated instance would come back on the real profile.
    if ctx.os == "windows" && !ctx.identity_vars.is_empty() {
        return Err(ReleasePageReason::IsolatedInstance);
    }
    let target = format!(
        "{}-{}-{}",
        updater_os(&ctx.os),
        ctx.arch,
        kind.installer_name()
    );
    if PUBLISHED_TARGETS.contains(&target.as_str()) {
        Ok(target)
    } else {
        Err(ReleasePageReason::UnsupportedInstall)
    }
}

/// The method and reason the frontend shows for a route.
pub fn route_summary(route: &UpdateInstallRoute) -> (UpdateInstallMethod, Option<ReleasePageReason>) {
    match route {
        Ok(_) => (UpdateInstallMethod::InApp, None),
        Err(reason) => (UpdateInstallMethod::ReleasePage, Some(*reason)),
    }
}

/// Whether a parsed `plugins.updater` config entry carries a public key.
pub fn updater_pubkey_configured(updater_config: Option<&serde_json::Value>) -> bool {
    updater_config
        .and_then(|c| c.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
}

/// Refuse anything but the newer version the user agreed to install.
///
/// `offered` is the version in the signed manifest, `expected` the one the
/// update check showed. Downgrades and same-version reinstalls are refused (the
/// desktop downgrade policy: never install an older build in place), and a
/// manifest that names a different version than the check is refused too.
pub fn check_offered_version(running: &str, offered: &str, expected: &str) -> Result<(), String> {
    let parse = |v: &str| Version::parse(v.trim_start_matches('v'));
    let running_v = parse(running).map_err(|e| format!("invalid running version {running}: {e}"))?;
    let offered_v = parse(offered).map_err(|e| format!("invalid update version {offered}: {e}"))?;
    let expected_v =
        parse(expected).map_err(|e| format!("invalid expected version {expected}: {e}"))?;
    if offered_v != expected_v {
        return Err(format!(
            "the update manifest offers v{offered_v}, not the v{expected_v} you chose to install"
        ));
    }
    if offered_v <= running_v {
        return Err(format!(
            "v{offered_v} is not newer than the running v{running_v}; termiHub never downgrades in place"
        ));
    }
    Ok(())
}

/// Whether the updater plugin was registered (the build has an updater key).
pub struct UpdaterAvailability {
    configured: bool,
}

/// An update downloaded and verified by [`download_app_update`], waiting for
/// [`install_app_update_and_restart`].
#[derive(Default)]
pub struct PendingAppUpdate(Mutex<Option<(Update, Vec<u8>)>>);

/// Download progress of an in-app update.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateProgress {
    /// Bytes downloaded so far.
    #[cfg_attr(test, ts(type = "number"))]
    pub downloaded: u64,
    /// Total size, when the server sent one.
    #[cfg_attr(test, ts(type = "number | null"))]
    pub total: Option<u64>,
}

/// Register the updater plugin when the release config gave this build a public
/// key, and manage the install state either way. Called from `setup()`.
///
/// Without a key (`plugins.updater` absent, or its `pubkey` empty) the plugin is
/// not registered at all: its config needs a key, and every update keeps the
/// release-page route ([`ReleasePageReason::NoUpdaterKey`]).
pub fn register(app: &tauri::App) {
    let configured = updater_pubkey_configured(app.config().plugins.0.get("updater"));
    let configured = configured && {
        let plugin = tauri_plugin_updater::Builder::new()
            // Strictly newer only, whatever the config says (downgrade policy).
            .default_version_comparator(|current, release| release.version > current)
            .build();
        match app.handle().plugin(plugin) {
            Ok(()) => true,
            Err(err) => {
                warn!("In-app updater unavailable: {err}");
                false
            }
        }
    };
    info!(configured, "In-app updater");
    app.manage(UpdaterAvailability { configured });
    app.manage(PendingAppUpdate::default());
}

/// The install context of the running app.
pub fn live_context(app: &AppHandle, channel: UpdateChannel) -> InstallContext {
    let env: Vec<_> = std::env::vars_os().collect();
    InstallContext {
        channel,
        updater_configured: app
            .try_state::<UpdaterAvailability>()
            .is_some_and(|a| a.configured),
        install_kind: tauri::utils::platform::bundle_type().map(InstallKind::from_bundle_type),
        portable: app
            .try_state::<crate::utils::portable::AppMode>()
            .is_some_and(|m| m.is_portable()),
        identity_vars: crate::utils::relaunch::instance_identity_vars(&env),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

/// User-facing text for a release-page reason, used in command errors.
fn reason_text(reason: ReleasePageReason) -> &'static str {
    match reason {
        ReleasePageReason::NotStableChannel => "develop builds are updated from the download page",
        ReleasePageReason::NoUpdaterKey => "this build has no update signing key",
        ReleasePageReason::PackageManager => "this install is managed by the package manager",
        ReleasePageReason::Portable => "portable copies are replaced by hand",
        ReleasePageReason::IsolatedInstance => {
            "this instance runs on an isolated profile the installer would not keep"
        }
        ReleasePageReason::UnsupportedInstall => "this install type has no in-app update",
    }
}

/// Download and verify the update to `expected_version` (the version the check
/// showed). Emits [`DOWNLOAD_PROGRESS_EVENT`]. Installs nothing.
#[tauri::command]
pub async fn download_app_update(
    expected_version: String,
    app: AppHandle,
    pending: State<'_, PendingAppUpdate>,
) -> Result<(), String> {
    let target = install_route(&live_context(&app, super::update::build_channel()))
        .map_err(|r| format!("In-app update unavailable: {}", reason_text(r)))?;
    let running = app.package_info().version.to_string();
    info!(%target, %expected_version, %running, "Downloading in-app update");

    let updater = app
        .updater_builder()
        .target(target)
        .build()
        .map_err(|e| format!("Could not prepare the update: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Could not read the update manifest: {e}"))?
        .ok_or_else(|| format!("No signed update newer than v{running} was found"))?;
    check_offered_version(&running, &update.version, &expected_version)
        .map_err(|e| format!("Update refused: {e}"))?;

    let mut downloaded: u64 = 0;
    let progress_app = app.clone();
    // `download` verifies the minisign signature (and the signed version)
    // before it returns the bytes.
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit(
                    DOWNLOAD_PROGRESS_EVENT,
                    AppUpdateProgress { downloaded, total },
                );
            },
            || {},
        )
        .await
        .map_err(|e| format!("The update download failed: {e}"))?;
    info!(version = %update.version, bytes = bytes.len(), "In-app update downloaded and verified");
    *pending.0.lock().map_err(|_| "update state poisoned".to_string())? = Some((update, bytes));
    Ok(())
}

/// Install the downloaded update and restart termiHub.
///
/// macOS / Linux: the bundle is replaced in place, then the app relaunches
/// with this instance's environment ([`crate::utils::relaunch`]). Windows: the
/// plugin starts the installer and exits; the installer restarts the app.
#[tauri::command]
pub fn install_app_update_and_restart(
    app: AppHandle,
    pending: State<'_, PendingAppUpdate>,
) -> Result<(), String> {
    let (update, bytes) = pending
        .0
        .lock()
        .map_err(|_| "update state poisoned".to_string())?
        .take()
        .ok_or_else(|| "No downloaded update to install".to_string())?;
    info!(version = %update.version, "Installing in-app update");
    // `install` re-verifies the bytes before it touches anything.
    update
        .install(&bytes)
        .map_err(|e| format!("The update could not be installed: {e}"))?;
    let program = match appimage_path(&app) {
        Some(appimage) => appimage,
        None => crate::utils::relaunch::resolve_executable(std::env::current_exe)
            .map_err(|e| restart_error(&e))?,
    };
    crate::utils::relaunch::relaunch_app_as(&app, &crate::utils::relaunch::OsSpawner, program)
        .map_err(|e| restart_error(&e))
}

/// The AppImage file this app runs from (Linux), relaunched after an update.
#[cfg(target_os = "linux")]
fn appimage_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.env().appimage.map(std::path::PathBuf::from)
}

/// The AppImage file this app runs from: never, off Linux.
#[cfg(not(target_os = "linux"))]
fn appimage_path(_app: &AppHandle) -> Option<std::path::PathBuf> {
    None
}

/// The error for an update that installed but could not restart.
fn restart_error(err: &std::io::Error) -> String {
    format!("The update was installed, but termiHub could not restart itself ({err}). Quit and start termiHub again.")
}

#[cfg(test)]
#[path = "update_install_tests.rs"]
mod tests;
