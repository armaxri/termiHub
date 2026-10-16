//! Autodiscovery of a local MobaXterm configuration (#4850).
//!
//! MobaXterm only runs on Windows, so discovery is Windows-only; every other OS
//! (and a Windows machine without MobaXterm) gets an empty list and the user
//! picks a file by hand.
//!
//! Where MobaXterm keeps its sessions:
//!
//! - **Installed edition:** `%APPDATA%\MobaXterm\MobaXterm.ini`.
//! - **Documents:** `%USERPROFILE%\Documents\MobaXterm\MobaXterm.ini` (and the
//!   OneDrive-redirected Documents folder), used by setups that point
//!   MobaXterm's configuration at the user's documents.
//! - **Portable edition:** `MobaXterm.ini` next to `MobaXterm_Personal_*.exe` —
//!   it can live anywhere, so the user picks that file manually.
//!
//! The registry key `HKCU\Software\Mobatek\MobaXterm` holds MobaXterm's
//! password and credential vault (and its master-password check), **not** its
//! bookmarks — sessions are always in the ini. termiHub deliberately never
//! reads that key: passwords are not imported.

#[cfg(any(windows, test))]
use std::path::Path;
use std::path::PathBuf;

/// Where a discovered configuration came from.
// Only constructed by the Windows discovery (and tests).
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateSource {
    /// `%APPDATA%\MobaXterm` — the installed edition.
    Installed,
    /// A `Documents\MobaXterm` folder.
    Documents,
}

impl CandidateSource {
    /// Stable wire label for the DTO.
    pub fn label(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::Documents => "documents",
        }
    }
}

#[cfg(any(windows, test))]
/// The base directories discovery looks under. Injected so path resolution is
/// testable on every OS.
#[derive(Debug, Clone, Default)]
pub struct DiscoveryEnv {
    /// `%APPDATA%` (roaming).
    pub app_data: Option<PathBuf>,
    /// `%USERPROFILE%`.
    pub user_profile: Option<PathBuf>,
    /// The known Documents folder (may be redirected, e.g. to OneDrive).
    pub documents: Option<PathBuf>,
}

#[cfg(any(windows, test))]
/// File name MobaXterm uses for its configuration.
const INI_NAME: &str = "MobaXterm.ini";

#[cfg(any(windows, test))]
/// Every place a MobaXterm configuration may be, in preference order, with
/// duplicates removed. Pure: does not touch the file system.
pub fn candidate_paths(env: &DiscoveryEnv) -> Vec<(PathBuf, CandidateSource)> {
    let mut out: Vec<(PathBuf, CandidateSource)> = Vec::new();
    let mut push = |path: PathBuf, source: CandidateSource| {
        if !out.iter().any(|(p, _)| p == &path) {
            out.push((path, source));
        }
    };
    if let Some(app_data) = &env.app_data {
        push(
            app_data.join("MobaXterm").join(INI_NAME),
            CandidateSource::Installed,
        );
    }
    if let Some(docs) = &env.documents {
        push(
            docs.join("MobaXterm").join(INI_NAME),
            CandidateSource::Documents,
        );
    }
    if let Some(profile) = &env.user_profile {
        for docs in [
            profile.join("Documents"),
            profile.join("OneDrive").join("Documents"),
        ] {
            push(
                docs.join("MobaXterm").join(INI_NAME),
                CandidateSource::Documents,
            );
        }
    }
    out
}

#[cfg(any(windows, test))]
/// Keep only the candidates that `exists` reports as present. Missing paths,
/// unreadable directories and the like simply drop out — never an error.
pub fn existing_candidates(
    candidates: Vec<(PathBuf, CandidateSource)>,
    exists: impl Fn(&Path) -> bool,
) -> Vec<(PathBuf, CandidateSource)> {
    candidates.into_iter().filter(|(p, _)| exists(p)).collect()
}

/// The discovery environment of this machine.
#[cfg(windows)]
fn system_env() -> DiscoveryEnv {
    DiscoveryEnv {
        app_data: std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(dirs::config_dir),
        user_profile: std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(dirs::home_dir),
        documents: dirs::document_dir(),
    }
}

/// Find the MobaXterm configurations present on this machine (Windows only).
#[cfg(windows)]
pub fn discover() -> Vec<(PathBuf, CandidateSource)> {
    existing_candidates(candidate_paths(&system_env()), Path::is_file)
}

/// MobaXterm is Windows-only: nothing to discover elsewhere.
#[cfg(not(windows))]
pub fn discover() -> Vec<(PathBuf, CandidateSource)> {
    Vec::new()
}
