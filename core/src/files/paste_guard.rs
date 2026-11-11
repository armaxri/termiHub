//! Refuse a same-session paste of a file onto itself, or of a folder into
//! itself, on the paths that do not go through [`FileBrowser::copy`] (#5330).
//!
//! A same-session paste is not always a same-backend copy. A file pasted
//! between two streaming ends of one session runs through the remote→remote
//! executor ([`remote_copy`](crate::files::transfer::remote_copy)), which
//! creates (truncates) the destination before it reads the source. When both
//! are the same file, the source is emptied while it is read. A byte-based
//! folder paste (FTP, older agents) creates the destination folder and then
//! lists the source, so a destination inside the source is copied into
//! itself again and again.
//!
//! The frontend's path check is textual, so it misses a symlink alias, a
//! `..` and a respelled path. This module resolves both paths **on the
//! backend** and refuses the paste before anything is written:
//!
//! - SFTP: the server's `realpath`.
//! - Docker: `readlink -f` / `pwd -P` inside the container.
//! - Every other backend (FTP, agent-hosted sessions): a lexical
//!   normalisation of `.`, `..` and repeated slashes. These backends have no
//!   way to resolve a symlink.
//!
//! A destination that does not exist yet resolves through its parent folder.
//! A path the backend cannot resolve is not a refusal: the paste then fails
//! with its own, more specific error.
//!
//! The wording matches the same-backend copy guards of #5320 and #5325. Once
//! `core::files::copy_guard` (#5325) lands, [`copy_conflict`] and
//! [`copy_refused`] can fold into it.

use std::future::Future;

use crate::errors::FileError;
use crate::files::FileBrowser;

#[cfg(feature = "docker")]
use crate::backends::docker::DockerTransferTarget;
#[cfg(feature = "ssh")]
use crate::backends::ssh::SftpFileBrowser;

/// Why a copy onto itself is refused.
pub const SAME_FILE: &str = "source and destination are the same file";

/// Why a copy of a folder into its own subtree is refused.
pub const INSIDE_SOURCE: &str = "the destination is inside the source folder";

/// Why copying `src` to `dest` must be refused, if it must. Both paths must
/// already be resolved. The answer is [`SAME_FILE`] for the same entry, or
/// [`INSIDE_SOURCE`] for a folder copied into itself.
pub fn copy_conflict(src: &str, dest: &str, src_is_dir: bool) -> Option<&'static str> {
    let src = src.trim_end_matches('/');
    let dest = dest.trim_end_matches('/');
    if src == dest {
        return Some(SAME_FILE);
    }
    // The root folder trims to "", so every absolute path lies inside it.
    if src_is_dir && dest.starts_with(&format!("{src}/")) {
        return Some(INSIDE_SOURCE);
    }
    None
}

/// The error of a refused copy, worded like the SFTP and local guards:
/// `copy <src> to <dest> refused: <reason>`.
pub fn copy_refused(src: &str, dest: &str, reason: &str) -> FileError {
    FileError::OperationFailed(format!("copy {src} to {dest} refused: {reason}"))
}

/// Resolve `.`, `..` and repeated or trailing slashes of a POSIX path
/// without asking the backend. An absolute path stays absolute (`..` stops
/// at the root). A relative path stays relative and keeps a leading `..`
/// that cannot be resolved.
pub fn normalize_lexically(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => match parts.last() {
                Some(&last) if last != ".." => {
                    parts.pop();
                }
                _ if absolute => {}
                _ => parts.push(".."),
            },
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    match (absolute, joined.is_empty()) {
        (true, _) => format!("/{joined}"),
        (false, true) => ".".to_string(),
        (false, false) => joined,
    }
}

/// Split a path into its parent folder and final name.
fn split_parent(path: &str) -> (&str, &str) {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => ("/", &trimmed[1..]),
        Some(i) => (&trimmed[..i], &trimmed[i + 1..]),
        None => (".", trimmed),
    }
}

/// Resolve `path` with `canon`. When `canon` cannot resolve it (a copy
/// destination that does not exist yet), resolve its parent folder and
/// append the final name. `None` when neither resolves.
pub(crate) async fn resolve_through_parent<F, Fut>(path: &str, canon: F) -> Option<String>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Option<String>>,
{
    if let Some(resolved) = canon(path.to_string()).await {
        return Some(resolved);
    }
    let (parent, name) = split_parent(path);
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let parent = canon(parent.to_string()).await?;
    Some(if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    })
}

/// Refuse a copy of `src` to `dest` when the two resolve, through `resolve`,
/// to the same entry, or when the folder `src` would be copied into its own
/// subtree. A path that does not resolve is not a refusal.
pub async fn check_resolved<F, Fut>(
    src: &str,
    dest: &str,
    src_is_dir: bool,
    resolve: F,
) -> Result<(), FileError>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Option<String>>,
{
    let Some(src_resolved) = resolve(src.to_string()).await else {
        return Ok(());
    };
    let Some(dest_resolved) = resolve(dest.to_string()).await else {
        return Ok(());
    };
    match copy_conflict(&src_resolved, &dest_resolved, src_is_dir) {
        Some(reason) => Err(copy_refused(src, dest, reason)),
        None => Ok(()),
    }
}

/// How a session's backend resolves a path to its real spelling. Owned, so a
/// caller can let go of the session before the (remote) lookups run.
#[derive(Clone)]
pub enum PathResolver {
    /// The SFTP server's `realpath`.
    #[cfg(feature = "ssh")]
    Sftp(SftpFileBrowser),
    /// `readlink -f` / `pwd -P` inside the container.
    #[cfg(feature = "docker")]
    Docker(DockerTransferTarget),
    /// No backend lookup: `.`, `..` and slashes only ([`normalize_lexically`]).
    Lexical,
}

impl std::fmt::Debug for PathResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            #[cfg(feature = "ssh")]
            PathResolver::Sftp(_) => "Sftp",
            #[cfg(feature = "docker")]
            PathResolver::Docker(_) => "Docker",
            PathResolver::Lexical => "Lexical",
        })
    }
}

impl PathResolver {
    /// The resolver of the backend behind `browser`: SFTP and Docker resolve
    /// on the backend, every other backend lexically.
    pub fn of_browser(browser: &dyn FileBrowser) -> Self {
        #[cfg(feature = "ssh")]
        if let Some(sftp) = browser
            .as_any()
            .and_then(|any| any.downcast_ref::<SftpFileBrowser>())
        {
            return PathResolver::Sftp(sftp.clone());
        }
        #[cfg(feature = "docker")]
        if let Some(target) = crate::backends::docker::docker_transfer_target_of(browser) {
            return PathResolver::Docker(target);
        }
        let _ = browser;
        PathResolver::Lexical
    }

    /// The real spelling of `path` on this backend (a missing final name
    /// resolves through its parent), or `None` when it cannot be resolved.
    pub async fn resolve(&self, path: &str) -> Option<String> {
        match self {
            #[cfg(feature = "ssh")]
            PathResolver::Sftp(sftp) => {
                use crate::backends::ssh::SftpAdvancedOps;
                resolve_through_parent(path, |p| async move { sftp.realpath(&p).await.ok() })
                    .await
            }
            #[cfg(feature = "docker")]
            PathResolver::Docker(target) => target.resolve_path(path).await,
            PathResolver::Lexical => Some(normalize_lexically(path)),
        }
    }

    /// Refuse a copy of `src` onto itself, or of the folder `src` into its
    /// own subtree, on this backend. See [`check_resolved`].
    pub async fn ensure_copy_allowed(
        &self,
        src: &str,
        dest: &str,
        src_is_dir: bool,
    ) -> Result<(), FileError> {
        check_resolved(src, dest, src_is_dir, |p| async move {
            self.resolve(&p).await
        })
        .await
    }
}

#[cfg(test)]
#[path = "paste_guard_tests.rs"]
mod tests;
