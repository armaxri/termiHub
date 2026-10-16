//! Expansion of MobaXterm path placeholders in imported key paths (#4850).
//!
//! MobaXterm rewrites the start of stored file paths into portable tokens:
//! `_ProfileDir_` (the Windows user profile), `_MyDocuments_` (the Documents
//! folder), `_AppDataDir_` (roaming AppData), `_DesktopDir_` (the Desktop) and
//! `_CurrentDrive_` (the drive letter MobaXterm runs from, written as
//! `_CurrentDrive_:\…`). They are resolved against the importing machine so a
//! key path such as `_ProfileDir_\.ssh\id_ed25519` lands on the user's real
//! `.ssh` folder on every OS. A token we cannot resolve is left in place and
//! reported, never guessed.

use std::path::PathBuf;

/// The directories placeholders resolve to. Injected so the expansion is
/// unit-testable without touching the real environment.
#[derive(Debug, Clone, Default)]
pub struct PlaceholderEnv {
    pub profile_dir: Option<PathBuf>,
    pub documents_dir: Option<PathBuf>,
    pub app_data_dir: Option<PathBuf>,
    pub desktop_dir: Option<PathBuf>,
    /// Drive letter for `_CurrentDrive_` (e.g. `"C"`); Windows only.
    pub current_drive: Option<String>,
}

impl PlaceholderEnv {
    /// Resolve the directories of the machine termiHub runs on.
    pub fn from_system() -> Self {
        Self {
            profile_dir: dirs::home_dir(),
            documents_dir: dirs::document_dir(),
            app_data_dir: dirs::config_dir(),
            desktop_dir: dirs::desktop_dir(),
            current_drive: current_drive(),
        }
    }
}

/// The system drive letter on Windows (`%SystemDrive%`, default `C`).
#[cfg(windows)]
fn current_drive() -> Option<String> {
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    drive
        .chars()
        .next()
        .filter(char::is_ascii_alphabetic)
        .map(|c| c.to_string())
}

/// `_CurrentDrive_` has no meaning off Windows.
#[cfg(not(windows))]
fn current_drive() -> Option<String> {
    None
}

/// Result of expanding one stored path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpandedPath {
    pub path: String,
    /// The placeholder that could not be resolved, if any.
    pub unresolved: Option<String>,
}

/// Directory placeholders, matched case-sensitively at the start of a path.
const DIR_TOKENS: [&str; 4] = [
    "_ProfileDir_",
    "_MyDocuments_",
    "_AppDataDir_",
    "_DesktopDir_",
];

fn dir_for<'a>(token: &str, env: &'a PlaceholderEnv) -> Option<&'a PathBuf> {
    match token {
        "_ProfileDir_" => env.profile_dir.as_ref(),
        "_MyDocuments_" => env.documents_dir.as_ref(),
        "_AppDataDir_" => env.app_data_dir.as_ref(),
        "_DesktopDir_" => env.desktop_dir.as_ref(),
        _ => None,
    }
}

/// Join the `\`-separated remainder of a stored path onto `base` with the
/// native separator, skipping empty segments.
fn join_windows_tail(base: &std::path::Path, tail: &str) -> String {
    let mut out = base.to_path_buf();
    for segment in tail.split(['\\', '/']).filter(|s| !s.is_empty()) {
        out.push(segment);
    }
    out.to_string_lossy().into_owned()
}

/// Leading `_Token_` of a path that looks like an (unknown) placeholder.
fn leading_token(path: &str) -> Option<&str> {
    let rest = path.strip_prefix('_')?;
    let end = rest.find('_')?;
    let name = &rest[..end];
    (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric())).then(|| &path[..end + 2])
}

/// Expand the MobaXterm placeholder at the start of `raw` (already
/// escape-decoded). Paths without a placeholder are returned unchanged.
pub fn expand_path(raw: &str, env: &PlaceholderEnv) -> ExpandedPath {
    let raw = raw.trim();
    if let Some(rest) = raw.strip_prefix("_CurrentDrive_") {
        return match env.current_drive.as_deref() {
            Some(drive) => ExpandedPath {
                path: format!("{drive}{rest}"),
                unresolved: None,
            },
            None => ExpandedPath {
                path: raw.to_string(),
                unresolved: Some("_CurrentDrive_".to_string()),
            },
        };
    }
    for token in DIR_TOKENS {
        if let Some(rest) = raw.strip_prefix(token) {
            return match dir_for(token, env) {
                Some(base) => ExpandedPath {
                    path: join_windows_tail(base, rest),
                    unresolved: None,
                },
                None => ExpandedPath {
                    path: raw.to_string(),
                    unresolved: Some(token.to_string()),
                },
            };
        }
    }
    ExpandedPath {
        path: raw.to_string(),
        unresolved: leading_token(raw).map(str::to_string),
    }
}
