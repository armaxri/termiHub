//! "Open in File Manager" for local folders, validated in the backend (#3115).
//!
//! The file browser's "Open in Finder / Explorer / File Manager" action used to
//! call the opener plugin's `openPath` straight from the webview, which needs the
//! `opener:allow-open-path` capability. That permission opens **any** path with
//! its default handler, so a compromised webview could launch an executable,
//! a script or an app bundle. The capability is gone; the webview reaches only the
//! `local_open_folder` command (`crate::commands::files`), which opens
//! nothing but an existing local **directory**.
//!
//! One catch: some directories are not opened as folders. A macOS bundle such as
//! `Foo.app` *launches* when opened, and a Windows folder named `name.{CLSID}`
//! is handed to that shell extension. Those are revealed (selected in their
//! parent folder) instead, which never runs anything.

use std::path::{Path, PathBuf};

use crate::utils::errors::TerminalError;

/// What [`resolve_folder_target`] decided to do with a path.
#[derive(Debug, PartialEq, Eq)]
pub enum FolderTarget {
    /// Open the folder itself in the OS file manager.
    Open(PathBuf),
    /// Reveal (select) the entry in its parent folder: it would launch or be
    /// handled by an extension if opened.
    Reveal(PathBuf),
}

/// macOS bundle extensions that launch, install or load something when opened
/// rather than showing their contents. Compared case-insensitively.
const LAUNCHING_BUNDLE_EXTENSIONS: &[&str] = &[
    "app",
    "appex",
    "action",
    "bundle",
    "framework",
    "kext",
    "mdimporter",
    "plugin",
    "prefpane",
    "qlgenerator",
    "saver",
    "service",
    "workflow",
    "xpc",
];

/// Whether opening the directory `name` would launch or delegate to something
/// instead of showing a folder.
///
/// Checked on every platform: a folder that merely *looks* like a bundle on
/// Linux is still shown (revealed), so being conservative costs nothing.
pub fn launches_when_opened(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    // Windows shell junction: `name.{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`.
    if lower.ends_with('}') && lower.contains(".{") {
        return true;
    }
    match lower.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => LAUNCHING_BUNDLE_EXTENSIONS.contains(&ext),
        _ => false,
    }
}

/// Drop the Windows verbatim prefix `canonicalize` adds (`\\?\C:\…`,
/// `\\?\UNC\server\share\…`), which Explorer does not accept as a folder to open.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

/// Validate `path` and decide how to show it.
///
/// The path must be non-empty, absolute and an existing directory (a symlink is
/// followed and checked by what it points to). The returned path is the
/// canonical one, so a symlink named `docs` pointing at `Foo.app` is caught.
pub fn resolve_folder_target(path: &str) -> Result<FolderTarget, TerminalError> {
    if path.is_empty() {
        return Err(TerminalError::InvalidParams(
            "no folder to open was given".to_string(),
        ));
    }
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err(TerminalError::InvalidParams(format!(
            "folder path must be absolute: {path}"
        )));
    }
    let canonical = std::fs::canonicalize(requested).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            TerminalError::NotFound(path.to_string())
        } else {
            TerminalError::Io(e)
        }
    })?;
    if !canonical.is_dir() {
        return Err(TerminalError::InvalidParams(format!(
            "only folders can be opened in the file manager: {path}"
        )));
    }
    let canonical = strip_verbatim_prefix(canonical);
    let launches = canonical
        .file_name()
        .map(|n| launches_when_opened(&n.to_string_lossy()))
        .unwrap_or(false);
    Ok(if launches {
        FolderTarget::Reveal(canonical)
    } else {
        FolderTarget::Open(canonical)
    })
}

/// The `explorer.exe` that opens folders on Windows: `%SystemRoot%\explorer.exe`,
/// by absolute path so a stray `explorer.exe` earlier on `PATH` is never run.
pub fn explorer_program(system_root: Option<&std::ffi::OsStr>) -> PathBuf {
    let root = system_root
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("explorer.exe")
}

/// The raw command-line argument that makes `explorer.exe` open `dir` itself.
///
/// Explorer splits an unquoted argument at commas and reads a leading `/` as an
/// option (`/select,…`, `/root,…`), so the folder is always passed in double
/// quotes (a Windows path cannot contain `"`). Only an absolute folder from
/// [`resolve_folder_target`] reaches here; anything option-shaped or carrying a
/// quote is refused rather than handed to Explorer.
pub fn explorer_open_arg(dir: &Path) -> Result<String, TerminalError> {
    let text = dir.to_string_lossy();
    if text.is_empty() || text.starts_with('/') || text.starts_with('-') || text.contains('"') {
        return Err(TerminalError::InvalidParams(format!(
            "not a folder Explorer can open: {text}"
        )));
    }
    Ok(format!("\"{text}\""))
}

/// Open `dir` in a new Explorer window on Windows (#5290).
///
/// Runs `explorer.exe "<dir>"` instead of the opener plugin's
/// `SHOpenFolderAndSelectItems(dir, [dir])`. On the Server 2025 / Windows 11
/// Explorer that call created a window but left it on the user's home folder
/// (`C:\Users\<user>`) instead of `dir`; Explorer navigates a window it starts
/// from its command line straight to the folder. Explorer's exit code carries
/// no meaning (it is 1 on success), so only a failure to start it is an error.
#[cfg(windows)]
pub fn open_in_explorer(dir: &Path) -> Result<(), TerminalError> {
    use std::os::windows::process::CommandExt;

    let arg = explorer_open_arg(dir)?;
    let program = explorer_program(std::env::var_os("SystemRoot").as_deref());
    std::process::Command::new(program)
        .raw_arg(arg)
        .spawn()
        .map(drop)
        .map_err(|e| TerminalError::EditorError(format!("could not start Explorer: {e}")))
}

#[cfg(test)]
#[path = "open_folder_tests.rs"]
mod tests;
